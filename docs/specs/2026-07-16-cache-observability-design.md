# Cache Observability & Config — Design Spec

**Date:** 2026-07-16
**Status:** approved
**Scope:** Three targeted improvements to `extensions/opencode-go-cache.ts`

## Motivation

The extension correctly stamps `prompt_cache_key`, `prompt_cache_retention`, and
`cache_control` breakpoints on every opencode-go request, but there is zero
observability into whether the gateway actually honors them. Users see
`opencode-go-cache: enabled` in the footer but have no idea if they're getting
cache hits. The TTL is hardcoded. And the stale-marker stripping walks the
entire payload tree every request.

## Improvements

### 1. Response Hook & TUI Cache Stats

**Hook:** Register `before_provider_response` alongside the existing
`before_provider_request`. Fires after the provider returns, giving access to
the raw response body.

**Parsing:** Extract `usage` from the response. The gateway returns different
fields depending on API:

- `openai-completions`: `usage.prompt_tokens_details.cached_tokens` (cache hit)
  divided by `usage.prompt_tokens` (total input)
- `anthropic-messages`: `usage.cache_read_input_tokens` (cache hit) divided by
  `usage.input_tokens` (total)

The hook checks which fields are present and computes the hit ratio.

**State:** Module-level cumulative counters:

```ts
let cacheStats = { totalInputTokens: 0, totalCacheHitTokens: 0 };
```

**Footer format:** `"opencode-go-cache: 87%"` (whole-number percentage of
cumulative hits / total input). On first turn before any response, show
`"opencode-go-cache: --"`. For GLM/skipped models, show
`"opencode-go-cache: unsupported"` as before.

**Error handling:** Wrapped in try/catch. If parsing fails (error response,
missing usage, unexpected format), silently keep the previous footer value.
Never blocks or breaks the LLM flow.

### 2. TTL Env Config

**Env var:** `PI_OPENCODE_CACHE_TTL`

**Behavior:**

| Value                 | Effect                                                 |
| --------------------- | ------------------------------------------------------ |
| Unset                 | Default `"1h"` (unchanged behavior)                    |
| `"2h"`, `"30m"`, etc. | Sets `cache_control.ttl` to the given value            |
| `"0"` or `"off"`      | Omits `ttl` entirely — sends bare `{type:"ephemeral"}` |
| Invalid               | Warns at module load, falls back to `"1h"`             |

**Implementation:** Read `process.env.PI_OPENCODE_CACHE_TTL` once at module
load time (top-level). Validate with regex `/^(\d+[hm]|0|off)$/i`. Cache the
resolved value in the existing `CACHE_CONTROL_EPHEMERAL` constant — replacing
the hardcoded `Object.freeze({ type: "ephemeral", ttl: "1h" })`. Invalid values
trigger `console.warn()` and fall back to the default.

### 3. Optimized `stripStaleCacheControl`

**Current:** Recursive `visit()` walks every node in `messages`, `system`, and
`tools` — O(n) over the entire payload — deleting any `cache_control` with
`type === "ephemeral"`.

**Replacement:** The stamping functions already know where they place markers
(the 2+2+1 pattern). Instead of a full tree walk, `applyConversationCacheBreakpoints`
returns the indices it stamped. Those indices are passed to a targeted
`clearPreviousMarkers(messages, previousIndices)` call before the next stamp pass.

**Impact:** Removes the 25-line recursive `stripStaleCacheControl` function.
Adds ~15 lines of position tracking in the stamping functions. Net code
reduction. Complexity goes from O(n) payload walk to O(k) where k ≤ 5.

## Non-Goals

- Persisting `prompt_cache_key` across session reconnects (architecturally
  different — would require file I/O and session lifecycle awareness)
- Configuration file or `models.json` integration (stays env-var-only)
- Multi-file architecture (stays single-file)

## Testing Strategy

1. **Unit:** Mock `before_provider_response` with representative usage payloads
   from both APIs, verify percentage computation and footer strings
2. **Integration:** Run a two-turn Pi session with the extension active and a
   logging proxy between Pi and the gateway; verify cache stats appear and
   increment correctly
3. **TTL config:** Set `PI_OPENCODE_CACHE_TTL=30m`, verify the outgoing
   `cache_control` has `ttl: "30m"`; set `PI_OPENCODE_CACHE_TTL=off`, verify
   the `ttl` field is absent; set invalid value, verify warning and fallback

## Migration

No breaking changes. Existing users get the new footer format automatically on
next request. The default TTL remains `"1h"` when the env var is unset.
