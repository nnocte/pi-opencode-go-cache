# pi-opencode-go-cache

A small [pi](https://pi.dev) extension that adds proper prompt caching for
[OpenCode Go](https://opencode.ai/docs/go) models (deepseek, mimo, kimi,
qwen, minimax, glm). Without it, pi sends these models to the gateway with
zero cache instrumentation and you pay full input price on every turn. With
it, the gateway caches your session prefix for 24 hours and reuses it, so
long coding sessions get dramatically cheaper after the first call.

**Source / issues:** [github.com/nnocte/pi-opencode-go-cache](https://github.com/nnocte/pi-opencode-go-cache)

## Why this exists

The OpenCode Go gateway (`opencode.ai/zen/go`) caches the request prefix
automatically, but only barely — a ~5 minute TTL, no per-session key, no
explicit breakpoints. After 5 minutes of inactivity, or when the gateway
decides your prefix doesn't match, it recomputes everything from scratch.

There are three knobs that fix this, and pi's built-in providers set **none
of them** for opencode-go:

- `prompt_cache_key` — scope the cache to this pi session so it survives
  across many turns instead of being keyed only on the prefix hash.
- `prompt_cache_retention: "24h"` — keep the cache alive for a day instead
  of 5 minutes.
- `cache_control` breakpoints — tell the gateway exactly which points in
  the conversation to cache, so the cache stays useful as the conversation
  grows instead of only caching the very first prefix.

Pi-ai only stamps `cache_control` when a model's compat sets
`cacheControlFormat: "anthropic"`, and the opencode-go models don't. So by
default you get the gateway's 5-minute auto cache and nothing more. This
extension turns all three knobs on for every opencode-go model, with no
config on your side.

## What it does

It hooks pi's `before_provider_request` event — which fires after pi-ai
has built the request payload but before it goes on the wire — and rewrites
the payload in place:

1. Strip any stale `cache_control` markers left over from the previous turn
   (so breakpoints land exactly where we want them this turn, not wherever
   they happened to land last time).
2. Set `prompt_cache_key` to the pi session id (clamped to 64 chars; in
   practice a no-op since pi session ids are 36-char uuidv7s).
3. Set `prompt_cache_retention: "24h"`.
4. Stamp `cache_control: {type:"ephemeral", ttl:"1h"}` on up to 2 system
   messages, the last 2 user/assistant messages, and the last tool. That's
   up to 5 breakpoints — the stable prefix (system) plus the moving tail
   (recent turns + tool schemas).
5. Show live cache hit percentages in the TUI footer — cumulative (`CU`)
   and per-message (`TB`) — so you can see caching working in real time
   (e.g. `opencode-go-cache: CU98% TB100%`).

None of this adds input tokens. `cache_control` is metadata attached to
existing message parts, and `prompt_cache_key` / `prompt_cache_retention`
are top-level request fields. The token count the gateway sees is identical
to what pi would send anyway — the extension only changes how the gateway
caches that content.

The breakpoints are the key part. Each one tells the gateway "cache
everything up to and including this point." With several of them, the
system prompt and earlier turns stay cached even as the last message
changes every turn:

```
   Turn 1                    Turn 2                    Turn 3
   ──────                    ──────                    ──────
   ┌─ system ─✦  ◀── new    ┌─ system ─✦   ◀── hit  ┌─ system ─✦     ◀── hit
   │  user              │    │  user         ◀── hit  │  user          ◀── hit
   └────────────────────┘    │  assistant ✦  ◀── new │  assistant ✦   ◀── hit
                             │  user              │   │  user           ◀── hit
                             └────────────────────┘   │  assistant ✦   ◀── new
                                                      │  user              │
                                                      └────────────────────┘

   ✦ = cache_control breakpoint
   ◀── hit = prefix matched and read from cache (cheap)
   ◀── new = freshly written (one-time, usually free on opencode-go)
```

## How it compares to opencode CLI

This is the part that surprised me when I tested it. I had assumed the
extension just replicated what opencode CLI does. It doesn't — it does
more.

I ran both through a local logging proxy (plain HTTP, pointed at the real
gateway) and captured the actual outgoing JSON for the same prompt on the
same model. Here's what each one sends:

| field                            | pi + this extension  | opencode CLI (openai-completions) | opencode CLI (anthropic-messages)  |
| -------------------------------- | -------------------- | --------------------------------- | ---------------------------------- |
| `prompt_cache_key` (per-session) | **set**              | not sent                          | not sent                           |
| `prompt_cache_retention`         | **`"24h"`**          | not sent                          | not sent                           |
| `cache_control` markers          | **3–5** (`ttl:"1h"`) | **0**                             | 2–3 (`{type:"ephemeral"}`, no ttl) |
| effective marker TTL             | **1 hour**           | —                                 | ~5 min (Anthropic default)         |

The short version: opencode CLI sends **zero** cache instrumentation for
the openai-completions models (deepseek, mimo, kimi) — it relies entirely
on the gateway's 5-minute auto cache. For the anthropic-messages models
(minimax-m3, qwen3.7) it does stamp `cache_control`, but with no `ttl`
field (so ~5 min) and no `prompt_cache_key` or `prompt_cache_retention`.

The extension sets all three knobs on every model, and on both retention
values it's at the documented ceiling: `ttl:"1h"` is the Anthropic-native
max for `cache_control`, and `"24h"` is the max value in opencode's own
`promptCacheRetention` schema (`enum["in_memory","24h"]`). So there's no
"make it longer" available — 1h and 24h are the tops, and the extension is
already there.

**Conclusion:** pi + this extension is strictly more aggressive than
opencode CLI on both caching (breakpoints on every model, not just
anthropic-messages ones) and retention (1h marker ttl + 24h top-level
retention, vs opencode's "nothing" or "5min default"). On long sessions
that means more cache hits and a cache that survives longer pauses. It
costs nothing extra — no additional tokens, and `cacheWrite` is free on
most opencode-go models anyway.

## What you save

Cache reads are 5–120× cheaper than input tokens on opencode-go. The
extension makes those reads actually happen and persist:

| Model             | API                | Cache ratio | cacheWrite cost |
| ----------------- | ------------------ | ----------- | --------------- |
| deepseek-v4-pro   | openai-completions | 120×        | free            |
| deepseek-v4-flash | openai-completions | 50×         | free            |
| mimo-v2.5-pro     | openai-completions | 120×        | free            |
| mimo-v2.5         | openai-completions | 50×         | free            |
| qwen3.6-plus      | openai-completions | 10×         | $0.625/M        |
| qwen3.7-plus      | anthropic-messages | 10×         | $0.50/M         |
| qwen3.7-max       | anthropic-messages | 5×          | $3.125/M        |
| kimi-k2.7-code    | openai-completions | 5×          | free            |
| kimi-k2.6         | openai-completions | 5.9×        | free            |
| minimax-m3        | anthropic-messages | 5×          | free            |
| minimax-m2.7      | openai-completions | 5×          | free            |

On a long coding session, the deepseek and mimo models end up around
80–95% off the input bill after the first call.

## Why not just `PI_CACHE_RETENTION=long`?

That env var gets you part of the way, but it can't get you all of it:

|                                               | `PI_CACHE_RETENTION=long` | this extension |
| --------------------------------------------- | :-----------------------: | :------------: |
| `prompt_cache_retention: "24h"`               |            ✅             |       ✅       |
| `prompt_cache_key` (per-session)              |            ✅             |       ✅       |
| `cache_control` breakpoints on every model    |            ❌             |       ✅       |
| Works for `anthropic-messages` models too     |            ❌             |       ✅       |
| No env vars or `models.json` overrides needed |            ❌             |       ✅       |

You could also hand-edit `~/.pi/agent/models.json` to set
`compat.cacheControlFormat: "anthropic"` per model, which gets pi-ai to
stamp 3 breakpoints (system + last tool + last conversation message) —
but only for models you configure, and still without the 24h retention.
The extension does the full recipe for every opencode-go model in one
place, with nothing to configure.

## TUI footer — cache hit percentages

Starting with v0.4.0, the extension shows live cache hit percentages in the
pi footer instead of a static "enabled" label:

```
opencode-go-cache: CU98% TB100%
```

- **CU** — cumulative average across all turns in the session. On a fresh
  session, starts at 0% and climbs as cache builds up. Tracks how much of
  your total input cost has been saved over the entire session.
- **TB** — per-message cache hit ratio for the last assistant response.
  Shows how much of that specific response came from cache. Typically near
  100% after the first exchange in a warm session.

Before the first response arrives, the footer shows `opencode-go-cache: --`.
For GLM/Zhipu models that reject `cache_control` markers, it shows
`opencode-go-cache: unsupported`.

## Configuring cache TTL

The `cache_control` marker TTL defaults to `"1h"` (the Anthropic-native
max). You can override it with the `PI_OPENCODE_CACHE_TTL` env var:

```bash
# Use a 30-minute TTL
PI_OPENCODE_CACHE_TTL=30m pi

# Send bare {type:"ephemeral"} with no ttl field (gateway uses its default ~5 min)
PI_OPENCODE_CACHE_TTL=off pi
```

Valid values: any positive number followed by `h` or `m` (e.g. `"2h"`,
`"90m"`). Use `"0"` or `"off"` to omit the ttl field entirely. Invalid
values print a warning and fall back to `"1h"`.

Note that the TTL is per-marker — the extension re-stamps markers on every
turn, so the cache never actually expires as long as you send prompts more
than once per hour. The TTL is a safety net, not a countdown.

## Known limitations

The OpenCode Go gateway is supposed to strip Anthropic-style
`cache_control` markers for downstream APIs that don't speak Anthropic,
but it doesn't do so for **GLM (Zhipu)** models. Stamping them makes GLM
reject the request with `Extra inputs are not permitted, field:
...cache_control`.

To avoid breaking those models, the extension detects GLM model ids
(substring match on `glm` / `zhipu`) and skips all cache stamping for
them — the request goes out unchanged, and the footer shows
`opencode-go-cache: unsupported` so it's obvious why caching is off. If
other models turn out to have the same problem, add them to
`UNSUPPORTED_CACHE_MODEL_PATTERNS` in
`extensions/opencode-go-cache.ts`.

## Install

```bash
# recommended
pi install npm:pi-opencode-go-cache

# from github
pi install git:github.com/nnocte/pi-opencode-go-cache

# one-off, no install
pi -e npm:pi-opencode-go-cache
```

No settings changes needed — it's passive, it just hooks the request.

## Verification

Cache instrumentation was verified via live proxy testing (v0.3.x) and the
v0.4.0 cache hit display was confirmed working in live pi sessions against
the real gateway. The extension correctly stamps `prompt_cache_key`,
`prompt_cache_retention`, and `cache_control` markers on every request, and
the gateway returns `cacheRead > 0` on turn 2+ — confirming the cache is
active and the hit percentages shown in the footer are accurate.

To reproduce: point pi at a local HTTP proxy (`127.0.0.1:8420`) with
`opencode-go.baseUrl` overridden. Send two prompts with the same model.
The first request shows the three cache fields on the wire; the second
request's response shows `cacheRead` tokens and the footer updates with
the hit percentage.

## Uninstall

```bash
pi remove npm:pi-opencode-go-cache
# or
pi remove git:github.com/nnocte/pi-opencode-go-cache
```

This unloads the extension but leaves your pi config untouched. There's
nothing else to clean up — the extension doesn't write state anywhere.

## License

MIT
