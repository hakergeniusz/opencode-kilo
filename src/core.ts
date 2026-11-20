/**
 * Framework-free core of opencode-kilo.
 *
 * Everything in this module is plain TypeScript + Web APIs. No pi runtime and
 * no OpenCode SDK imports live here, so the logic stays easy to reason about
 * and test. The OpenCode plugin (src/index.ts) only adapts these values to the
 * V2 plugin context.
 */

// ---------------------------------------------------------------------------
// Settings (plugin options first, environment variables as fallback)
// ---------------------------------------------------------------------------

export interface KiloSettings {
  apiUrl: string
  apiKey?: string
  organizationId?: string
  models: string
  debug: boolean
}

export const TOS_URL = "https://kilo.ai/terms"
export const TOKEN_EXPIRATION_MS = 365 * 24 * 60 * 60 * 1000
export const MODELS_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000
export const STICKY_MAX = 20

function pickOption(
  options: Record<string, unknown>,
  name: string,
  envNames: string[],
): string | undefined {
  const fromOptions = options[name]
  if (typeof fromOptions === "string" && fromOptions.trim()) return fromOptions.trim()
  for (const envName of envNames) {
    const fromEnv = process.env[envName]
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  }
  return undefined
}

export function resolveSettings(options: Record<string, unknown>): KiloSettings {
  return {
    apiUrl: pickOption(options, "apiUrl", ["KILO_API_URL"]) ?? "https://api.kilo.ai",
    apiKey: pickOption(options, "apiKey", ["KILO_API_KEY"]),
    organizationId: pickOption(options, "organizationId", [
      "KILO_ORG_ID",
      "KILOCODE_ORGANIZATION_ID",
    ]),
    models: pickOption(options, "models", ["KILO_MODELS"]) ?? "",
    debug:
      options.debug === true ||
      process.env.OPENCODE_KILO_DEBUG === "1",
  }
}

export function apiBase(settings: KiloSettings): string {
  return settings.apiUrl.replace(/\/+$/, "")
}

export function gatewayBase(settings: KiloSettings): string {
  return `${apiBase(settings)}/api/gateway`
}

export function openrouterBase(settings: KiloSettings): string {
  return `${apiBase(settings)}/api/openrouter`
}

export function debugLog(
  settings: KiloSettings,
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (!settings.debug) return
  try {
    console.error("[opencode-kilo] " + JSON.stringify({ event, ...data }))
  } catch {
    // Debug logging must never break the provider.
  }
}

// ---------------------------------------------------------------------------
// Access (stored OAuth credential or API key)
// ---------------------------------------------------------------------------

export interface StoredCredential {
  token: string
  organizationId?: string
  expires?: number
}

export interface KiloAccess {
  token: string
  organizationId?: string
}

/** Stored OAuth credentials take precedence over the API key. */
export function resolveAccess(
  settings: KiloSettings,
  stored: StoredCredential | undefined,
): KiloAccess | undefined {
  if (stored && typeof stored.token === "string" && stored.token) {
    if (stored.expires === undefined || stored.expires > Date.now()) {
      return {
        token: stored.token,
        organizationId: stored.organizationId || settings.organizationId,
      }
    }
    debugLog(settings, "stored-token-expired")
  }
  if (settings.apiKey) {
    return { token: settings.apiKey, organizationId: settings.organizationId }
  }
  return undefined
}

export function catalogKey(access: KiloAccess | undefined): string {
  return access ? `org-${access.organizationId || "default"}` : "free"
}

// ---------------------------------------------------------------------------
// Device-code OAuth login
// ---------------------------------------------------------------------------

interface DeviceAuthResponse {
  code: string
  verificationUrl: string
  expiresIn: number
}

type PollStatus = "pending" | "approved" | "denied" | "expired"

interface DeviceAuthPollResponse {
  status: PollStatus
  token?: string
  userEmail?: string
}

interface KiloOrganization {
  id: string
  name: string
  role?: string
}

interface KiloProfile {
  user?: { email?: string; name?: string }
  organizations?: KiloOrganization[]
}

function endpoint(settings: KiloSettings, path: string): string {
  return `${apiBase(settings)}${path}`
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"))
      return
    }
    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout)
        reject(new Error("Login cancelled"))
      },
      { once: true },
    )
  })
}

export async function initiateDeviceAuth(
  settings: KiloSettings,
  signal?: AbortSignal,
): Promise<DeviceAuthResponse> {
  const response = await fetch(endpoint(settings, "/api/device-auth/codes"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
  })
  if (response.status === 429) {
    throw new Error("Too many pending authorization requests. Please try again later.")
  }
  if (!response.ok) {
    throw new Error(`Failed to initiate device authorization: ${response.status}`)
  }
  return (await response.json()) as DeviceAuthResponse
}

export async function pollDeviceAuth(
  settings: KiloSettings,
  code: string,
  signal?: AbortSignal,
): Promise<DeviceAuthPollResponse> {
  const response = await fetch(endpoint(settings, `/api/device-auth/codes/${code}`), { signal })
  if (response.status === 202) return { status: "pending" }
  if (response.status === 403) return { status: "denied" }
  if (response.status === 410) return { status: "expired" }
  if (!response.ok) {
    throw new Error(`Failed to poll device authorization: ${response.status}`)
  }
  return (await response.json()) as DeviceAuthPollResponse
}

async function fetchKiloProfile(
  settings: KiloSettings,
  token: string,
  signal?: AbortSignal,
): Promise<KiloProfile> {
  const response = await fetch(endpoint(settings, "/api/profile"), {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal,
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch Kilo profile: ${response.status}`)
  }
  return (await response.json()) as KiloProfile
}

/**
 * Choose an organization from plugin options / environment. If no interactive
 * picker is available and no organization is pinned, the personal account is
 * used.
 */
export async function selectOrganization(
  settings: KiloSettings,
  token: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  let profile: KiloProfile
  try {
    profile = await fetchKiloProfile(settings, token, signal)
  } catch {
    return settings.organizationId
  }

  const organizations = profile.organizations ?? []
  if (
    settings.organizationId &&
    organizations.some((org) => org.id === settings.organizationId)
  ) {
    return settings.organizationId
  }
  // No interactive picker: keep the personal account unless the user pinned
  // an organization via options/env.
  return settings.organizationId
}

/** Poll until the browser flow approves/denies/expires, or the deadline passes. */
export async function waitForDeviceAuth(
  settings: KiloSettings,
  code: string,
  signal: AbortSignal,
  expiresInSeconds: number,
): Promise<string> {
  const deadline = Date.now() + expiresInSeconds * 1000
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error("Login cancelled")
    await abortableSleep(3000, signal)
    const result = await pollDeviceAuth(settings, code, signal)
    if (result.status === "approved") {
      if (!result.token) throw new Error("Authorization approved but no token received")
      return result.token
    }
    if (result.status === "denied") throw new Error("Authorization denied by user")
    if (result.status === "expired") throw new Error("Authorization code expired. Please try again")
  }
  throw new Error("Authentication timed out. Please try again")
}

// ---------------------------------------------------------------------------
// Model catalog fetch
// ---------------------------------------------------------------------------

export interface OpenRouterModel {
  id: string
  name: string
  context_length: number
  max_completion_tokens?: number | null
  pricing?: {
    prompt?: string | null
    completion?: string | null
    input_cache_write?: string | null
    input_cache_read?: string | null
  }
  architecture?: {
    input_modalities?: string[] | null
    output_modalities?: string[] | null
  }
  top_provider?: { max_completion_tokens?: number | null }
  supported_parameters?: string[]
  opencode?: {
    variants?: Record<string, { reasoning?: { enabled?: boolean; effort?: string }; verbosity?: string }>
    ai_sdk_provider?: string
  }
}

const MODELS_FETCH_TIMEOUT_MS = 10_000

export async function fetchCatalog(
  settings: KiloSettings,
  access: KiloAccess | undefined,
  signal?: AbortSignal,
): Promise<OpenRouterModel[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "opencode-kilo",
  }
  if (access?.token) headers.Authorization = `Bearer ${access.token}`

  const url = access?.organizationId
    ? endpoint(
        settings,
        `/api/organizations/${encodeURIComponent(access.organizationId)}/models`,
      )
    : endpoint(settings, "/api/gateway/models")

  const timeout = AbortSignal.timeout(MODELS_FETCH_TIMEOUT_MS)
  const response = await fetch(url, {
    headers: access?.organizationId
      ? { ...headers, "X-KiloCode-OrganizationId": access.organizationId }
      : headers,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`)
  }
  const json = (await response.json()) as { data?: OpenRouterModel[] }
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid models response: missing data array")
  }
  return json.data
}

// ---------------------------------------------------------------------------
// Catalog entry -> OpenCode-ready model description
// ---------------------------------------------------------------------------

export interface MappedCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface MappedModel {
  id: string
  name: string
  /** "chat" uses openai-compatible chat, "responses" uses the Responses protocol. */
  protocol: "chat" | "responses"
  /** Per-model package override (OpenCode resolves model.package ?? provider.package). */
  package?: string
  /** Per-model settings override (baseURL differs for the Responses gateway). */
  settings?: Record<string, unknown>
  compatibility: Record<string, unknown>
  capabilities: {
    tools: boolean
    input: string[]
    output: string[]
    temperature: boolean
  }
  cost: MappedCost
  contextWindow: number
  maxTokens: number
  variants: Array<{ id: string; settings: Record<string, unknown> }>
}

function parsePrice(price: string | null | undefined): number {
  if (!price) return 0
  const parsed = parseFloat(price)
  if (Number.isNaN(parsed)) return 0
  // OpenRouter prices are per-token; OpenCode expects per-million-token.
  return parsed * 1_000_000
}

function isFreeModelId(id: string): boolean {
  if (id === "kilo-auto/free") return true
  if (id.includes(":free")) return true
  if (!id.includes("/")) return true
  if (id.startsWith("kilo/") || id.startsWith("openrouter/")) return true
  return false
}

function shouldUseResponsesApi(m: OpenRouterModel): boolean {
  if (m.opencode?.ai_sdk_provider === "openai") return true
  // Kilo routes current OpenAI reasoning/frontier models through Responses;
  // chat completions for these fail with "please use any of: responses".
  const id = m.id.toLowerCase()
  const shortId = id.includes("/") ? (id.split("/").pop() ?? id) : id
  return (
    shortId === "gpt-5" ||
    shortId.startsWith("gpt-5.") ||
    shortId.startsWith("gpt-5-") ||
    shortId.startsWith("o1") ||
    shortId.startsWith("o3") ||
    shortId.startsWith("o4")
  )
}

function mapVariantEffort(
  variants: NonNullable<OpenRouterModel["opencode"]>["variants"],
  key: string,
): string | undefined {
  const variant = variants?.[key]
  if (!variant) return undefined
  const reasoning = variant.reasoning
  if (!reasoning) return key
  if (reasoning.enabled === false || reasoning.effort === "none") return "none"
  return reasoning.effort ?? key
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

function thinkingEffortMap(m: OpenRouterModel): Partial<Record<ThinkingLevel, string>> {
  const variants = m.opencode?.variants
  const map: Partial<Record<ThinkingLevel, string>> = {}
  if (variants && Object.keys(variants).length > 0) {
    const off = mapVariantEffort(variants, "none") ?? mapVariantEffort(variants, "instant")
    if (off !== undefined) map.off = off
    for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const effort = mapVariantEffort(variants, level)
      if (effort !== undefined) map[level] = effort
    }
  }
  if (/^deepseek\/deepseek-v4-(flash|pro)(?:-|$)/.test(m.id)) map.max = "max"
  if (Object.keys(map).length === 0 && m.id.includes("gpt-5.5")) {
    Object.assign(map, {
      off: "none",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
    } satisfies Partial<Record<ThinkingLevel, string>>)
  }
  return map
}

function modelCompatibility(m: OpenRouterModel, protocol: "chat" | "responses"): Record<string, unknown> {
  if (protocol === "responses") {
    // Kilo/OpenRouter-compatible Responses endpoints do not need OpenAI's
    // session_id header; long prompt-cache retention is provider-specific.
    return { supportsPromptCacheKey: false }
  }
  const compat: Record<string, unknown> = {
    // Kilo's gateway is OpenRouter-compatible but sits on api.kilo.ai, so
    // OpenCode's URL/provider auto-detection cannot infer the quirks.
    reasoningField: "reasoning",
  }
  if (m.id.startsWith("anthropic/")) compat.cacheFormat = "anthropic"
  if (m.id === "deepseek/deepseek-v4-flash" || m.id === "deepseek/deepseek-v4-pro") {
    // Replay reasoning in the assistant message's `reasoning_content` field.
    compat.reasoningField = "reasoning_content"
    compat.requireReasoning = true
  }
  return compat
}

export function mapCatalog(raw: OpenRouterModel[], settings: KiloSettings): MappedModel[] {
  return raw
    .filter((m) => !(m.architecture?.output_modalities ?? []).includes("image"))
    .map((m) => {
      const inputModalities = m.architecture?.input_modalities ?? ["text"]
      const protocol = shouldUseResponsesApi(m) ? "responses" : "chat"
      const effortMap = thinkingEffortMap(m)
      const variants = Object.entries(effortMap).map(([level, effort]) => ({
        id: level,
        settings: { reasoningEffort: effort },
      }))

      return {
        id: m.id,
        name: m.name,
        protocol,
        ...(protocol === "responses"
          ? {
              package: "@opencode/ai/providers/openai-compatible-responses",
              settings: {
                baseURL: openrouterBase(settings),
                // Kilo/OpenRouter Responses endpoints reject stored responses.
                store: false,
              },
            }
          : {}),
        compatibility: modelCompatibility(m, protocol),
        capabilities: {
          tools: true,
          input: inputModalities.includes("image") ? ["text", "image"] : ["text"],
          output: ["text"],
          temperature: true,
        },
        cost: {
          input: parsePrice(m.pricing?.prompt),
          output: parsePrice(m.pricing?.completion),
          cacheRead: parsePrice(m.pricing?.input_cache_read),
          cacheWrite: parsePrice(m.pricing?.input_cache_write),
        },
        contextWindow: m.context_length,
        maxTokens:
          m.top_provider?.max_completion_tokens ??
          m.max_completion_tokens ??
          Math.ceil(m.context_length * 0.2),
        variants,
      } satisfies MappedModel
    })
}

// ---------------------------------------------------------------------------
// Which models get registered: free tier + sticky + KILO_MODELS patterns
// ---------------------------------------------------------------------------

function isFreeModel(m: MappedModel): boolean {
  return m.cost.input === 0 && m.cost.output === 0 && isFreeModelId(m.id)
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i")
}

export function selectRegisteredModels(
  catalog: MappedModel[],
  settings: KiloSettings,
  sticky: string[],
): MappedModel[] {
  if (settings.models.toLowerCase() === "all") return catalog

  const wanted = new Set<string>()
  for (const m of catalog) {
    if (isFreeModel(m)) wanted.add(m.id)
  }
  for (const id of sticky) {
    if (catalog.some((m) => m.id === id)) wanted.add(id)
  }
  for (const pattern of settings.models.split(",").map((p) => p.trim()).filter(Boolean)) {
    const re = globToRegex(pattern)
    for (const m of catalog) {
      if (re.test(m.id)) wanted.add(m.id)
    }
  }

  const picked = catalog.filter((m) => wanted.has(m.id))
  debugLog(settings, "registered-models", {
    count: picked.length,
    total: catalog.length,
    mode: settings.models || "default",
  })
  return picked
}
