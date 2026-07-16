# Cache Observability & Config — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use sub-agents (recommended) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cache hit observability, env-configurable TTL, and optimized marker stripping to the `pi-opencode-go-cache` extension.

**Architecture:** All changes are to the single file `extensions/opencode-go-cache.ts`. Three independent improvements applied in dependency order: (1) replace recursive marker stripping with targeted non-recursive clear, (2) add `PI_OPENCODE_CACHE_TTL` env var to replace hardcoded TTL, (3) add `message_end` hook to parse assistant message `usage` and render a cumulative cache hit percentage in the footer.

**Tech Stack:** TypeScript (jiti-loaded by Pi), Pi Extension API (`before_provider_request`, `message_end`, `model_select`, `session_shutdown`)

---

## File Map

| File                                                                                | Action     | Responsibility                      |
| ----------------------------------------------------------------------------------- | ---------- | ----------------------------------- |
| `extensions/opencode-go-cache.ts`                                                   | Modify     | All three improvements              |
| `~/.pi/agent/npm/node_modules/pi-opencode-go-cache/extensions/opencode-go-cache.ts` | Sync after | Installed copy (Pi loads from here) |

---

### Task 1: Optimize `stripStaleCacheControl` — non-recursive targeted clear

**Files:**

- Modify: `extensions/opencode-go-cache.ts` (replace `stripStaleCacheControl` function, lines 247-272)

**Rationale:** The current recursive `visit()` walks every nested object in `messages`, `system`, and `tools` looking for `cache_control` markers. Markers only ever appear at known surfaces: message content parts, system content blocks, and tool definition objects. We don't need a recursive tree walk — a single-level iteration over these known positions catches all stale markers while being ~15 lines shorter and eliminating recursion overhead.

- [ ] **Step 1: Replace `stripStaleCacheControl` function**

Replace the entire function (lines 247-272) with:

```typescript
/**
 * Clear all stale ephemeral cache_control markers from the payload.
 * Only checks known marker surfaces (message content parts, system blocks,
 * tool defs) — no recursive tree walk needed since markers never appear
 * deeper than one level in these structures.
 */
function stripStaleCacheControl(payload: Record<string, unknown>): void {
  const clearContent = (content: unknown): void => {
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.cache_control && typeof p.cache_control === 'object') {
        const cc = p.cache_control as Record<string, unknown>;
        if (cc.type === 'ephemeral') delete p.cache_control;
      }
    }
  };

  // Messages: clear markers from each message's content parts.
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages as Array<Record<string, unknown>>) {
      clearContent(msg.content);
    }
  }

  // System prompt: can be a string (no marker possible) or content blocks.
  clearContent(payload.system);

  // Tools: clear marker from the top-level tool object.
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools as Array<Record<string, unknown>>) {
      if (tool.cache_control && typeof tool.cache_control === 'object') {
        const cc = tool.cache_control as Record<string, unknown>;
        if (cc.type === 'ephemeral') delete tool.cache_control;
      }
    }
  }
}
```

- [ ] **Step 2: Verify the file still loads**

The extension is TypeScript loaded by jiti at runtime — there's no build step. Verify syntax is valid:

```bash
cd /data/forks/pi-opencode-go-cache && node -e "require('jiti')(__filename)" 2>&1 || true
# jiti may not be globally available; the real test is Pi loading the extension.
# Check for obvious syntax errors:
node --check /data/forks/pi-opencode-go-cache/extensions/opencode-go-cache.ts 2>&1 && echo "Syntax OK" || echo "Syntax errors found"
```

Note: `node --check` on TypeScript will likely report TS syntax as unexpected. That's expected — Pi uses jiti. The real validation is loading via Pi.

- [ ] **Step 3: Sync to installed copy**

```bash
cp /data/forks/pi-opencode-go-cache/extensions/opencode-go-cache.ts \
   ~/.pi/agent/npm/node_modules/pi-opencode-go-cache/extensions/opencode-go-cache.ts
```

- [ ] **Step 4: Manual smoke test**

In a running Pi session with an opencode-go model active:

1. Send a prompt and confirm it completes without error
2. Confirm the footer shows `opencode-go-cache: enabled`
3. Send a second prompt and confirm no errors

- [ ] **Step 5: Commit**

```bash
cd /data/forks/pi-opencode-go-cache
git add extensions/opencode-go-cache.ts
git commit -m "refactor: replace recursive stripStaleCacheControl with non-recursive targeted clear"
```

---

### Task 2: TTL Env Config (`PI_OPENCODE_CACHE_TTL`)

**Files:**

- Modify: `extensions/opencode-go-cache.ts` (replace `CACHE_CONTROL_EPHEMERAL` constant, lines 47-51)

**Rationale:** The `ttl: "1h"` is hardcoded. Let users override it via `PI_OPENCODE_CACHE_TTL` env var. Supports values like `"2h"`, `"30m"`, `"0"`/`"off"` (omit ttl entirely). Invalid values warn and fall back to `"1h"`.

- [ ] **Step 1: Replace `CACHE_CONTROL_EPHEMERAL` constant**

Replace lines 47-51:

```typescript
/**
 * Anthropic-style cache breakpoint marker.
 *
 * The `ttl` field is controlled by the PI_OPENCODE_CACHE_TTL env var:
 *   - unset → "1h" (default, Anthropic-native max)
 *   - "30m", "2h", etc. → sets ttl to that value
 *   - "0" or "off" → omits ttl entirely (bare {type:"ephemeral"})
 *   - invalid → warns at load time, falls back to "1h"
 */
const TTL_VALUE = resolveCacheTTL();

function resolveCacheTTL(): string | undefined {
  const raw = process.env.PI_OPENCODE_CACHE_TTL;
  if (!raw) return '1h'; // default
  if (/^\d+[hm]$/i.test(raw)) return raw;
  if (/^(0|off)$/i.test(raw)) return undefined;
  console.warn(
    `opencode-go-cache: PI_OPENCODE_CACHE_TTL="${raw}" is invalid (expected e.g. "30m", "2h", "0", "off"). Falling back to "1h".`,
  );
  return '1h';
}

const CACHE_CONTROL_EPHEMERAL = Object.freeze(
  TTL_VALUE !== undefined ? { type: 'ephemeral' as const, ttl: TTL_VALUE } : { type: 'ephemeral' as const },
);
```

Remove the old doc comment and `CACHE_CONTROL_EPHEMERAL` definition at lines 45-51, replacing with the above.

- [ ] **Step 2: Update module docstring**

At line 42, add to the usage section:

```typescript
 *   • Set PI_OPENCODE_CACHE_TTL to override the cache_control ttl (default "1h").
 *     Valid: "30m", "2h", etc. "0" or "off" omits ttl entirely.
```

- [ ] **Step 3: Verify syntax**

```bash
node --check /data/forks/pi-opencode-go-cache/extensions/opencode-go-cache.ts 2>&1 && echo "Syntax OK" || echo "TS syntax (expected in node --check, fine for jiti)"
```

- [ ] **Step 4: Sync to installed copy**

```bash
cp /data/forks/pi-opencode-go-cache/extensions/opencode-go-cache.ts \
   ~/.pi/agent/npm/node_modules/pi-opencode-go-cache/extensions/opencode-go-cache.ts
```

- [ ] **Step 5: Test TTL values**

Set each env var and verify the marker via a logging proxy or by checking Pi logs:

```bash
# Test 1: Default (unset) → should see ttl: "1h" on wire
# Test 2: PI_OPENCODE_CACHE_TTL=30m → should see ttl: "30m"
# Test 3: PI_OPENCODE_CACHE_TTL=off → should see {type:"ephemeral"} with NO ttl field
# Test 4: PI_OPENCODE_CACHE_TTL=invalid → should see warning + fallback to "1h"
```

- [ ] **Step 6: Commit**

```bash
cd /data/forks/pi-opencode-go-cache
git add extensions/opencode-go-cache.ts
git commit -m "feat: add PI_OPENCODE_CACHE_TTL env var for configurable cache_control ttl"
```

---

### Task 3: Response Hook & TUI Cache Stats

**Files:**

- Modify: `extensions/opencode-go-cache.ts` (add `message_end` hook handler in `export default function`, lines 275-375)

**Rationale:** The extension stamps cache instrumentation but never checks if it works. Add a `message_end` hook that filters for assistant messages, parses `event.message.usage` for cache hit tokens (handling both `openai-completions` and `anthropic-messages` formats), tracks cumulative stats, and updates the footer from `"opencode-go-cache: enabled"` to `"opencode-go-cache: 87%"`.

- [ ] **Step 1: Add module-level cache stats state**

After the `CACHE_CONTROL_EPHEMERAL` constant declaration (~line 55), add:

```typescript
/** Cumulative cache usage across all turns in this session. */
const cacheStats = { totalInputTokens: 0, totalCacheHitTokens: 0 };
```

- [ ] **Step 2: Add usage parsing helper**

After `stripStaleCacheControl` and before `export default`, add:

```typescript
/**
 * Extract the cache hit ratio from an assistant message's usage object.
 * Handles both openai-completions ({prompt_tokens_details.cached_tokens})
 * and anthropic-messages ({cache_read_input_tokens}) formats.
 * Returns null if parsing fails or no cache data is present.
 */
function extractCacheHitRatio(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  let cachedTokens: number | undefined;
  let inputTokens: number | undefined;

  // Anthropic-messages format: cache_read_input_tokens + input_tokens
  if (typeof u.cache_read_input_tokens === 'number' && typeof u.input_tokens === 'number') {
    cachedTokens = u.cache_read_input_tokens;
    inputTokens = u.input_tokens;
  }
  // OpenAI-completions format: prompt_tokens_details.cached_tokens + prompt_tokens
  if (cachedTokens === undefined) {
    const details = u.prompt_tokens_details;
    if (details && typeof details === 'object') {
      const d = details as Record<string, unknown>;
      if (typeof d.cached_tokens === 'number' && typeof u.prompt_tokens === 'number') {
        cachedTokens = d.cached_tokens;
        inputTokens = u.prompt_tokens;
      }
    }
  }

  if (cachedTokens === undefined || inputTokens === undefined || inputTokens <= 0) {
    return null;
  }
  return cachedTokens / inputTokens;
}
```

- [ ] **Step 3: Register `message_end` hook**

Inside `export default function (pi: ExtensionAPI): void {`, after the existing hooks (before the closing `}`), add:

```typescript
// Cache hit observability: parse assistant message usage and update footer.
pi.on('message_end', (event, ctx) => {
  try {
    if (!ctx.hasUI) return;
    const msg = event.message as { role?: string; usage?: unknown } | undefined;
    if (!msg || msg.role !== 'assistant') return;

    // Only track stats for opencode-go models.
    const model = ctx.model as { provider?: string } | undefined;
    if (!model || model.provider !== PROVIDER_ID) return;
    if (isUnsupportedForCache(model as { id?: string; provider?: string })) return;

    const ratio = extractCacheHitRatio(msg.usage);
    if (ratio === null) {
      // No cache data yet (first turn or provider didn't return usage).
      if (lastStatusKey) {
        setStatus(ctx, 'opencode-go-cache', 'opencode-go-cache: --');
      }
      return;
    }

    // Accumulate stats and show running percentage.
    const u = msg.usage as Record<string, unknown>;
    // Re-extract raw numbers for accumulation (extractCacheHitRatio returns ratio only).
    let inputTokens = 0;
    let cachedTokens = 0;
    if (typeof u.cache_read_input_tokens === 'number' && typeof u.input_tokens === 'number') {
      cachedTokens = u.cache_read_input_tokens;
      inputTokens = u.input_tokens;
    } else {
      const details = u.prompt_tokens_details;
      if (details && typeof details === 'object') {
        const d = details as Record<string, unknown>;
        if (typeof d.cached_tokens === 'number' && typeof u.prompt_tokens === 'number') {
          cachedTokens = d.cached_tokens;
          inputTokens = u.prompt_tokens;
        }
      }
    }

    cacheStats.totalInputTokens += inputTokens;
    cacheStats.totalCacheHitTokens += cachedTokens;
    const pct =
      cacheStats.totalInputTokens > 0
        ? Math.round((cacheStats.totalCacheHitTokens / cacheStats.totalInputTokens) * 100)
        : 0;
    const label = cacheStats.totalInputTokens > 0 ? `opencode-go-cache: ${pct}%` : 'opencode-go-cache: --';

    setStatus(ctx, 'opencode-go-cache', label);
  } catch {
    // Silently ignore parse errors — never break the LLM flow.
  }
});
```

- [ ] **Step 4: Reset stats on session shutdown**

Update the existing `session_shutdown` handler to also reset `cacheStats`. Replace the current handler block (~line 370-375) with:

```typescript
// Drop the status and reset stats when the session ends so we don't
// leave a stale entry on the next session's footer.
pi.on('session_shutdown', (_event, ctx) => {
  cacheStats.totalInputTokens = 0;
  cacheStats.totalCacheHitTokens = 0;
  if (lastStatusKey && ctx.hasUI) {
    ctx.ui.setStatus(lastStatusKey, '');
    lastStatusKey = undefined;
  }
});
```

- [ ] **Step 5: Update `model_select` handler for consistency**

The `model_select` handler currently sets `"opencode-go-cache: enabled"` for opencode-go models. Now that the footer can show a percentage, we want model switches to show `"opencode-go-cache: --"` (until the next response arrives) instead of `"enabled"`. Update the `model_select` handler (replace the `setStatus` call at the end):

Change:

```typescript
setStatus(ctx, 'opencode-go-cache', 'opencode-go-cache: enabled');
```

To:

```typescript
setStatus(ctx, 'opencode-go-cache', 'opencode-go-cache: --');
```

- [ ] **Step 6: Also update `before_provider_request` footer text**

In the `before_provider_request` handler, change the success-path footer from `"enabled"` to `"--"` (the `message_end` hook will update it to a percentage once the response arrives). Replace:

```typescript
setStatus(ctx, 'opencode-go-cache', 'opencode-go-cache: enabled');
```

With:

```typescript
// Footer will be updated with cache hit % by message_end hook.
// Only set if we haven't already computed a percentage.
if (!lastStatusKey || !ctx.ui) {
  /* first-run — message_end will set the value */
}
```

Actually, simpler: just remove the setStatus call from `before_provider_request` entirely. The `message_end` hook handles all footer updates now. Remove the three lines:

```typescript
if (ctx.hasUI) {
  setStatus(ctx, 'opencode-go-cache', 'opencode-go-cache: enabled');
}
```

from the success path of `before_provider_request`.

- [ ] **Step 7: Verify syntax**

```bash
node --check /data/forks/pi-opencode-go-cache/extensions/opencode-go-cache.ts 2>&1 && echo "Syntax OK" || echo "TS syntax (expected in node --check, fine for jiti)"
```

- [ ] **Step 8: Sync to installed copy**

```bash
cp /data/forks/pi-opencode-go-cache/extensions/opencode-go-cache.ts \
   ~/.pi/agent/npm/node_modules/pi-opencode-go-cache/extensions/opencode-go-cache.ts
```

- [ ] **Step 9: Manual two-turn smoke test**

In a Pi session with an opencode-go model (e.g., `deepseek-v4-flash`):

1. Send a prompt — footer should show `opencode-go-cache: --` before first response, then `opencode-go-cache: 0%` after (first turn has no cache hits)
2. Send a second prompt — footer should show `opencode-go-cache: NN%` with a positive percentage after the second response
3. Switch to a non-opencode-go model — footer should clear
4. Switch back — footer should show `opencode-go-cache: --` until next response

- [ ] **Step 10: Commit**

```bash
cd /data/forks/pi-opencode-go-cache
git add extensions/opencode-go-cache.ts
git commit -m "feat: add cache hit observability with percentage in TUI footer"
```

---

### Task 4: Final Verification & Bump

**Files:**

- Modify: `package.json` (version bump)

- [ ] **Step 1: Run full two-turn test with all improvements active**

```bash
# Set TTL to test the env var too
PI_OPENCODE_CACHE_TTL=30m pi
# In Pi: select opencode-go model, send two prompts, observe:
# - Footer shows percentage after second turn
# - Check proxy logs: ttl should be "30m" not "1h"
```

- [ ] **Step 2: Verify GLM model handling still works**

Switch to a GLM model (e.g., `glm-5.2`). Footer should show `opencode-go-cache: unsupported`. Send a prompt — it should complete without error (no `cache_control` markers sent).

- [ ] **Step 3: Bump version**

```bash
cd /data/forks/pi-opencode-go-cache
# Current: 0.3.1 → bump to 0.4.0 (new features, no breaking changes)
```

Edit `package.json` line 3: change `"version": "0.3.1"` to `"version": "0.4.0"`.

- [ ] **Step 4: Commit version bump**

```bash
cd /data/forks/pi-opencode-go-cache
git add package.json
git commit -m "chore: bump version to 0.4.0"
```

- [ ] **Step 5: Push to fork**

```bash
cd /data/forks/pi-opencode-go-cache
git push origin main
```

---

## Verification Checklist (Post-Implementation)

- [ ] Syntax valid (jiti-compatible TypeScript)
- [ ] `stripStaleCacheControl` is non-recursive, targets only known surfaces
- [ ] `PI_OPENCODE_CACHE_TTL` env var: default `"1h"`, valid values applied, `"off"` omits ttl, invalid warns + fallback
- [ ] Footer shows `"opencode-go-cache: --"` before first response
- [ ] Footer shows `"opencode-go-cache: 0%"` after first turn
- [ ] Footer shows positive percentage after second turn
- [ ] Footer clears on model switch to non-opencode-go
- [ ] GLM models still show `"opencode-go-cache: unsupported"` and don't error
- [ ] Stats reset on `/new` or session restart
- [ ] No errors in Pi logs
