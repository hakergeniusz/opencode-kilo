/**
 * opencode-kilo — Kilo Code Gateway provider for OpenCode V2.
 *
 * Native port of hakergeniusz/pi-kilo. It registers one `kilo` provider with
 * an OpenCode-compatible model catalog, keeps registration cheap (free tier
 * + recently used models + KILO_MODELS overrides), and adds device-code OAuth
 * login via the `/kilo-login` command.
 */

import { Model, Plugin, Provider } from "@opencode/plugin"
import {
  catalogKey,
  debugLog,
  fetchCatalog,
  gatewayBase,
  initiateDeviceAuth,
  mapCatalog,
  MODELS_CACHE_MAX_AGE_MS,
  resolveAccess,
  resolveSettings,
  selectOrganization,
  selectRegisteredModels,
  STICKY_MAX,
  TOS_URL,
  TOKEN_EXPIRATION_MS,
  waitForDeviceAuth,
  type KiloAccess,
  type KiloSettings,
  type MappedModel,
  type StoredCredential,
} from "./core.js"
import { normalizeSseBody } from "./sse.js"

const PROVIDER_ID = "kilo"
const CHAT_PACKAGE = "@opencode/ai/providers/openai-compatible"
const AUTH_KEY = "auth"
const STICKY_KEY = "sticky"
const CATALOG_PREFIX = "catalog:"

interface CatalogCache {
  fetchedAt: number
  models: MappedModel[]
}

interface Disposable {
  dispose(): Promise<void>
}

export default Plugin.define({
  id: "opencode-kilo",
  async setup(ctx) {
    const settings = resolveSettings((ctx.options ?? {}) as Record<string, unknown>)
    // ctx.storage only accepts Schema.Json; our plain data structures are
    // JSON-shaped but lack the branded index signatures TypeScript wants.
    const setJson = (storageKey: string, value: unknown) =>
      ctx.storage.set(storageKey, value as Parameters<typeof ctx.storage.set>[1])
    debugLog(settings, "loaded")

    const stored = (await ctx.storage.get(AUTH_KEY)) as StoredCredential | undefined
    let access = resolveAccess(settings, stored)
    const key = catalogKey(access)
    const cached = (await ctx.storage.get(`${CATALOG_PREFIX}${key}`)) as CatalogCache | undefined
    const sticky = ((await ctx.storage.get(STICKY_KEY)) as string[] | undefined) ?? []

    /** Fetch + map + persist the catalog; an empty result means "keep serving cache". */
    const loadCatalog = async (a: KiloAccess | undefined): Promise<MappedModel[]> => {
      try {
        const raw = await fetchCatalog(settings, a)
        const models = mapCatalog(raw, settings)
        if (models.length > 0) {
          await setJson(`${CATALOG_PREFIX}${catalogKey(a)}`, {
            fetchedAt: Date.now(),
            models,
          } satisfies CatalogCache)
        }
        return models
      } catch (error) {
        debugLog(settings, "catalog-fetch-failed", {
          message: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    }

    let catalog: MappedModel[] = []
    if (cached && Array.isArray(cached.models) && cached.models.length > 0) {
      catalog = cached.models
    } else {
      catalog = await loadCatalog(access)
      if (catalog.length === 0 && key !== "free") {
        const free = (await ctx.storage.get(`${CATALOG_PREFIX}free`)) as CatalogCache | undefined
        catalog = free?.models?.length ? free.models : await loadCatalog(undefined)
      }
    }

    const state = {
      access,
      catalog,
      sticky,
      selected: selectRegisteredModels(catalog, settings, sticky),
    }

    /** Apply a freshly loaded catalog to the live provider registration. */
    const refreshRegistration = async (fresh: MappedModel[]): Promise<void> => {
      if (fresh.length === 0) return
      state.catalog = fresh
      state.selected = selectRegisteredModels(fresh, settings, state.sticky)
      await ctx.provider.reload()
    }

    // Stale-while-revalidate: serve cached entries, refresh for next launch.
    if (
      cached &&
      Array.isArray(cached.models) &&
      cached.models.length > 0 &&
      Date.now() - cached.fetchedAt > MODELS_CACHE_MAX_AGE_MS
    ) {
      void (async () => {
        const fresh = await loadCatalog(state.access)
        await refreshRegistration(fresh)
      })().catch((error) => debugLog(settings, "background-refresh-failed", {
        message: error instanceof Error ? error.message : String(error),
      }))
    }

    const providerID = Provider.ID.make(PROVIDER_ID)

    const toModelInfo = (m: MappedModel): Model.Info =>
      ({
        ...Model.Info.default(providerID, Model.ID.make(m.id)),
        name: m.name,
        cost: [
          {
            input: m.cost.input,
            output: m.cost.output,
            cache: { read: m.cost.cacheRead, write: m.cost.cacheWrite },
          },
        ],
        limit: { context: m.contextWindow, output: m.maxTokens },
        capabilities: m.capabilities,
        compatibility: m.compatibility,
        variants: m.variants.map((variant) => ({
          ...variant,
          id: Model.VariantID.make(variant.id),
        })),
        ...(m.package ? { package: m.package } : {}),
        ...(m.settings ? { settings: m.settings } : {}),
      }) as unknown as Model.Info

    const providerReg = await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          ...Provider.Info.empty(providerID),
          name: "Kilo",
          activation: "enabled",
          package: CHAT_PACKAGE,
          settings: {
            baseURL: gatewayBase(settings),
            ...(state.access ? { apiKey: state.access.token } : {}),
          },
          headers: {
            "X-KILOCODE-EDITORNAME": "OpenCode",
            "User-Agent": "opencode-kilo",
            ...(state.access?.organizationId
              ? { "X-KiloCode-OrganizationId": state.access.organizationId }
              : {}),
          },
        },
        models: state.selected.map(toModelInfo),
      })
    })

    const registrations: Disposable[] = [providerReg]

    // Normalize Kilo's `response.failed` SSE quirk for OpenAI Responses calls.
    registrations.push(
      await ctx.session.hook(
        "http.response",
        (event) => {
          const contentType = event.response.headers.get("content-type")?.toLowerCase() ?? ""
          if (!contentType.includes("text/event-stream") || !event.response.body) return
          event.response = new Response(normalizeSseBody(event.response.body), {
            status: event.response.status,
            statusText: event.response.statusText,
            headers: event.response.headers,
          })
        },
        { providerID: PROVIDER_ID },
      ),
    )

    // Dynamic headers (organization can change after login/logout).
    registrations.push(
      await ctx.session.hook(
        "model.request",
        (event) => {
          event.headers["X-KILOCODE-EDITORNAME"] = "OpenCode"
          event.headers["User-Agent"] = "opencode-kilo"
          const org = state.access?.organizationId ?? settings.organizationId
          if (org) event.headers["X-KiloCode-OrganizationId"] = org
        },
        { providerID: PROVIDER_ID },
      ),
    )

    // One-time Terms of Service notice on first use of a Kilo model, shown
    // only to unauthenticated users (same rule as pi-kilo).
    let tosShown = false
    registrations.push(
      await ctx.session.hook(
        "context",
        (event) => {
          if (tosShown) return
          tosShown = true
          if (state.access) return
          event.system.push({
            type: "text",
            text: `By using Kilo, you agree to the Terms of Service: ${TOS_URL}`,
          })
        },
        { providerID: PROVIDER_ID },
      ),
    )

    const rememberSticky = async (id: string): Promise<void> => {
      state.sticky = [id, ...state.sticky.filter((m) => m !== id)].slice(0, STICKY_MAX)
      await setJson(STICKY_KEY, state.sticky)
    }

    // Track recently selected Kilo models so they stay registered next launch.
    const eventController = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        types: ["session.model.selected"],
        signal: eventController.signal,
      })) {
        const model = event.data.model
        if (!model || model.providerID !== PROVIDER_ID) continue
        await rememberSticky(model.id)
      }
    })().catch((error) => {
      if (eventController.signal.aborted) return
      debugLog(settings, "event-subscription-failed", {
        message: error instanceof Error ? error.message : String(error),
      })
    })

    const loginControllers = new Map<string, AbortController>()

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: "kilo-login",
          description: "Sign in to Kilo Code Gateway with the OAuth device flow",
          execute: async ({ sessionID }) => {
            const controller = new AbortController()
            loginControllers.set(sessionID, controller)
            try {
              const { code, verificationUrl, expiresIn } = await initiateDeviceAuth(
                settings,
                controller.signal,
              )
              await ctx.session.synthetic({
                sessionID,
                text: `Kilo login: open ${verificationUrl} and enter code \`${code}\`.`,
              })
              const token = await waitForDeviceAuth(settings, code, controller.signal, expiresIn)
              const organizationId = await selectOrganization(settings, token, controller.signal)
              const credential: StoredCredential = {
                token,
                ...(organizationId ? { organizationId } : {}),
                expires: Date.now() + TOKEN_EXPIRATION_MS,
              }
              await setJson(AUTH_KEY, credential)
              access = resolveAccess(settings, credential)
              state.access = access
              await refreshRegistration(await loadCatalog(access))
              await ctx.session.synthetic({ sessionID, text: "Kilo login complete." })
            } catch (error) {
              await ctx.session.synthetic({
                sessionID,
                text: `Kilo login failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            } finally {
              loginControllers.delete(sessionID)
            }
          },
        })

        editor.add({
          name: "kilo-logout",
          description: "Remove the stored Kilo credential and fall back to free models",
          execute: async ({ sessionID }) => {
            await ctx.storage.remove(AUTH_KEY)
            access = resolveAccess(settings, undefined)
            state.access = access
            const free = (await ctx.storage.get(`${CATALOG_PREFIX}free`)) as
              | CatalogCache
              | undefined
            if (free?.models?.length) await refreshRegistration(free.models)
            else await ctx.provider.reload()
            await ctx.session.synthetic({ sessionID, text: "Kilo logged out." })
          },
        })
      }),
    )

    return async () => {
      eventController.abort()
      for (const controller of loginControllers.values()) controller.abort()
      await Promise.all(
        registrations.map(async (registration) => {
          try {
            await registration.dispose()
          } catch (error) {
            debugLog(settings, "dispose-failed", {
              message: error instanceof Error ? error.message : String(error),
            })
          }
        }),
      )
    }
  },
})
