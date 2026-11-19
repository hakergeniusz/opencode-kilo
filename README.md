# opencode-kilo

Kilo Code Gateway provider for **OpenCode V2**, a native port of
[`pi-kilo`](https://github.com/hakergeniusz/pi-kilo). It registers a single
`kilo` provider backed by Kilo's OpenRouter-compatible gateway with:

- a disk-style (plugin-storage) model catalog that is fetched once and then
  served from cache, with stale-while-revalidate refreshes in the background;
- **cheap startup**: by default only the free tier (12-ish models) plus models
  you have selected before (sticky) plus anything matching `KILO_MODELS` are
  registered — `KILO_MODELS=all` restores the full catalog;
- per-model protocol routing: OpenAI reasoning/frontier models use the
  Responses protocol, everything else uses OpenAI-compatible chat
  completions, including normalization of Kilo's `response.failed` SSE quirk;
- OAuth device-code login (`/kilo-login`) with organization selection via
  option/env, and a matching `/kilo-logout`.

## Load

Add the plugin to `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-kilo"]
}
```

A local checkout works too:

```jsonc
{
  "plugins": ["./path/to/opencode-kilo"]
}
```

Then pick one of the `kilo/...` models in the model picker, or run
`/kilo-login` to authenticate first.

## Options

Plugin options are passed with the object form in `opencode.json(c)`; the
original pi environment variables remain supported as fallbacks (options win).

```jsonc
{
  "plugins": [
    {
      "package": "opencode-kilo",
      "options": {
        "apiUrl": "https://api.kilo.ai",
        "apiKey": "...",
        "organizationId": "...",
        "models": "*gpt-5*,anthropic/claude-opus*",
        "debug": false
      }
    }
  ]
}
```

| Option | Env fallback | Default | Meaning |
| --- | --- | --- | --- |
| `apiUrl` | `KILO_API_URL` | `https://api.kilo.ai` | API base |
| `apiKey` | `KILO_API_KEY` | — | API key / token; else the stored OAuth credential is used |
| `organizationId` | `KILO_ORG_ID`, `KILOCODE_ORGANIZATION_ID` | — | Organization id sent as `X-KiloCode-OrganizationId` |
| `models` | `KILO_MODELS` | free + sticky | `all`, or comma-separated ids/globs. Patterns match the **full** id (anchored), so use `*gpt-5*` for ids like `openai/gpt-5.5` |
| `debug` | `PI_KILO_DEBUG=1`, `OPENCODE_KILO_DEBUG=1` | `false` | Trace logging to stderr |

Stored OAuth credentials take precedence over `apiKey`, matching pi-kilo.

## How it maps from the pi original

| pi-kilo | OpenCode V2 |
| --- | --- |
| `pi.registerProvider("kilo", …)` | `ctx.provider.transform` with `Provider.Info.empty("kilo")` and the `@opencode/ai/providers/openai-compatible` package |
| per-model `api: "openai-responses"` + `baseUrl` | per-model `package` override (`@opencode/ai/providers/openai-compatible-responses`) and `settings.baseURL` |
| custom `streamSimple` + `normalizeResponsesFetch` | `ctx.session.hook("http.response")` rewriting SSE frames (the `response.failed` quirk is preserved) |
| `thinkingLevelMap` / catalog variants | `Model.Info.variants` with `reasoningEffort` settings |
| compat flags (`thinkingFormat`, cache format, deepseek reasoning replay) | `Model.Info.compatibility` (`reasoningField`, `cacheFormat`, `requireReasoning`, `supportsPromptCacheKey`) |
| disk catalog cache + background refresh | `ctx.storage` JSON entries with stale-while-revalidate |
| `pi.on("model_select")` sticky models | `ctx.event.subscribe({ types: ["session.model.selected"] })` |
| `before_agent_start` ToS notice | `ctx.session.hook("context")` scoped to the `kilo` provider |
| `/login kilo` OAuth device flow | `/kilo-login` command via `ctx.command.transform`; `/kilo-logout` added |
| env-based config | `ctx.options` with the original env vars as fallbacks |

## Known gaps / differences

- OpenCode owns streaming. The pi-specific `streamSimple` implementation and
  `openAIResponsesApi()` wrapper cannot be injected; protocol selection is
  expressed through OpenCode provider packages instead. The important
  behavioral quirk (`response.failed` without `error.code`) is preserved by the
  `http.response` hook.
- Credentials live in plugin-scoped `ctx.storage`, not OpenCode's native auth
  store, and there is no automatic token refresh. Tokens last one year; after
  expiry, run `/kilo-login` again. `KILO_API_KEY` still works without login.
- pi-kilo's interactive organization picker has no server-side ask-user
  equivalent inside a command. Choose an organization with the
  `organizationId` option or `KILO_ORG_ID`; otherwise the personal account is
  used (the same fallback pi-kilo used without a selection callback).
- The catalog cache is no longer shared with pi's `kilo-pi-provider` directory;
  it is stored per plugin under `ctx.storage`.
- The ToS notice is injected once per plugin load as a system instruction (and
  only for unauthenticated users), rather than displayed as pi's custom
  user-facing message.
- No TUI part is needed: the original has no keybindings, widgets, or
  renderers. No tests were ported because the original project has none.

## License

MIT — 2026 hakergeniusz.
