# this plugin

Kilo Code Gateway provider for **OpenCode V2**. It registers a single `kilo`
provider backed by Kilo's OpenRouter-compatible gateway with:

- a cached model catalog stored in plugin storage, fetched once and refreshed
  in the background (stale-while-revalidate);
- **cheap startup**: by default only the free tier (12-ish models) plus models
  you have selected before (sticky) plus anything matching `KILO_MODELS` are
  registered — `KILO_MODELS=all` restores the full catalog;
- per-model protocol routing: OpenAI reasoning/frontier models use the
  Responses protocol, everything else uses OpenAI-compatible chat completions,
  including normalization of Kilo's `response.failed` SSE quirk;
- OAuth device-code login (`/kilo-login`) with organization selection via
  option/env, and a matching `/kilo-logout`.

## Load

Add the plugin to `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "plugins": ["this plugin"]
}
```

A local checkout works too:

```jsonc
{
  "plugins": ["./path/to/this plugin"]
}
```

Then pick one of the `kilo/...` models in the model picker, or run
`/kilo-login` to authenticate first.

## Options

Plugin options are passed with the object form in `opencode.json(c)`;
environment variables remain supported as fallbacks (options win).

```jsonc
{
  "plugins": [
    {
      "package": "this plugin",
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
| `debug` | `OPENCODE_KILO_DEBUG=1` | `false` | Trace logging to stderr |

Stored OAuth credentials take precedence over `apiKey`.

## How it works

- **Provider registration:** uses `ctx.provider.transform` to register the
  `kilo` provider with `@opencode/ai/providers/openai-compatible` as the base
  package.
- **Protocol routing:** OpenAI Responses-capable models are registered with a
  per-model package/settings override (`@opencode/ai/providers/openai-compatible-responses`
  and the configured Responses base URL).
- **SSE normalization:** a `http.response` hook rewrites `response.failed`
  events missing `error.code` so the Responses parser can handle them.
- **Variants and compatibility:** model variants are exposed with
  `reasoningEffort` settings and compatibility flags are set for gateway quirks.
- **Catalog caching:** catalog entries are stored in `ctx.storage` and refreshed
  in the background when stale.
- **Sticky models:** recently selected Kilo models are tracked from
  `session.model.selected` events and kept registered on next launch.
- **Auth:** `/kilo-login` performs OAuth device-code login and stores
  credentials in plugin storage; `/kilo-logout` removes them.

## Known gaps / differences

- OpenCode owns streaming. Protocol selection is expressed through OpenCode
  provider packages, and the `response.failed` quirk is handled by the
  `http.response` hook.
- Credentials live in plugin-scoped `ctx.storage`, not OpenCode's native auth
  store, and there is no automatic token refresh. Tokens last one year; after
  expiry, run `/kilo-login` again. `KILO_API_KEY` still works without login.
- There is no interactive organization picker inside commands. Choose an
  organization with the `organizationId` option or `KILO_ORG_ID`; otherwise the
  personal account is used.
- The catalog cache is stored per plugin under `ctx.storage`.
- The ToS notice is injected once per plugin load as a system instruction (and
  only for unauthenticated users).

## License

MIT — 2026 hakergeniusz.
