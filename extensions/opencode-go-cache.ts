/**
 * opencode-go-cache — Pi extension for OpenCode Go prompt caching.
 *
 * The OpenCode Go gateway (https://opencode.ai/zen/go) caches the request
 * prefix automatically, but only:
 *   • Up to ~5 minutes by default (short retention)
 *   • As a single, end-of-prefix breakpoint (no fine-grained control)
 *   • Without a session-scoped key (cache lookup uses just the prefix hash)
 *
 * OpenCode CLI works around this by:
 *   1. Setting `prompt_cache_key` to `sessionID` so the cache is scoped per
 *      session and survives across many turns.
 *   2. Adding Anthropic-style `cache_control: { type: "ephemeral" }` markers
 *      to the system prompt, the last tool, and the last two conversation
 *      messages — which produces multiple cache breakpoints and dramatically
 *      increases the hit rate as the conversation grows.
 *   3. Requesting `prompt_cache_retention: "24h"` so the cache survives long
 *      pauses between turns.
 *
 * Pi's built-in openai-completions provider only sets `prompt_cache_key` for
 * `api.openai.com` URLs (or when `cacheRetention === "long"`), and it never
 * adds `cache_control` markers to openai-completions messages for
 * opencode-go: pi-ai only stamps cache_control when a model's compat sets
 * `cacheControlFormat: "anthropic"`, and the opencode-go models don't. Its
 * anthropic-messages provider does add `cache_control` (system prompt + last
 * tool + last conversation message = 3 breakpoints) when that flag is set,
 * but never sets `prompt_cache_retention`.
 *
 * This extension applies the full OpenCode CLI caching strategy to every
 * opencode-go request, for both `openai-completions` and `anthropic-messages`
 * APIs. It runs entirely in the extension layer (jiti-loaded), so the
 * upstream pi-ai package stays untouched and the change is easy to remove
 * (just delete this file and `/reload`).
 *
 * Verification (live against the real gateway with the bundled API key):
 *   • kimi-k2.7-code  (openai-completions): cache goes from 0/N to N/N on
 *     the 2nd call, and stays N/N across many turns.
 *   • minimax-m3      (anthropic-messages): same.
 *
 * Usage: install via `pi install npm:pi-opencode-go-cache`, or drop this
 * file at `~/.pi/agent/extensions/opencode-go-cache.ts` and (re)start pi.
 * No settings changes required.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const PROVIDER_IDS = ['opencode-go', 'opencode-zen'];
const MAX_PROMPT_CACHE_KEY_LEN = 64;

/**
 * Anthropic-style cache breakpoint marker.
 *
 * Controlled by PI_OPENCODE_CACHE_TTL env var:
 *   - unset → "1h" (default)
 *   - "30m", "2h" etc. → applies that value
 *   - "0" or "off" → omits ttl entirely (bare {type:"ephemeral"})
 *   - invalid → warns, falls back to "1h"
 */
const TTL_VALUE = resolveCacheTTL();

function resolveCacheTTL(): string | undefined {
  const raw = process.env.PI_OPENCODE_CACHE_TTL;
  if (!raw) return '1h';
  if (/^[1-9]\d*[hm]$/i.test(raw)) return raw.toLowerCase();
  if (/^(0|off)$/i.test(raw)) return undefined;
  console.warn(
    `opencode-go-cache: PI_OPENCODE_CACHE_TTL="${raw}" is invalid (expected e.g. "30m", "2h", "0", "off"). Falling back to "1h".`,
  );
  return '1h';
}

const CACHE_CONTROL_EPHEMERAL = Object.freeze(
  TTL_VALUE !== undefined ? { type: 'ephemeral' as const, ttl: TTL_VALUE } : { type: 'ephemeral' as const },
);

/** Cumulative cache usage across all turns in this session. Assumes one-session-per-process (module-level state). */
const cacheStats = { totalInputTokens: 0, totalCacheHitTokens: 0 };

/**
 * Clamp the prompt cache key to the gateway's documented max length
 * (matches the helper in `@earendil-works/pi-ai/providers/openai-prompt-cache`).
 * The Pi session id is a uuidv7 (36 chars) so this is a no-op in practice,
 * but we keep the guard for safety.
 */
function clampPromptCacheKey(key: string | undefined): string | undefined {
  if (!key) return undefined;
  if (key.length <= MAX_PROMPT_CACHE_KEY_LEN) return key;
  return Array.from(key).slice(0, MAX_PROMPT_CACHE_KEY_LEN).join('');
}

function isOpencodeGoModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
  if (!model) return false;
  if (!model || !PROVIDER_IDS.includes(model.provider)) return false;
  return true;
}

/**
 * Models for which the OpenCode Go gateway does NOT strip Anthropic-style
 * cache_control markers, and the downstream API rejects them outright.
 * For these, we must skip all cache stamping or every request errors with
 * "Extra inputs are not permitted, field: ...cache_control".
 *
 * Substring match against the model id (e.g. "opencode-go/glm-5.2" or
 * "opencode-go/zhipu-glm"). Add other models here as they're discovered.
 */
const UNSUPPORTED_CACHE_MODEL_PATTERNS: readonly string[] = ['glm', 'zhipu'];

function isUnsupportedForCache(model: { id?: string; provider?: string } | undefined): boolean {
  if (!model) return false;
  const id = (model.id ?? '').toLowerCase();
  return UNSUPPORTED_CACHE_MODEL_PATTERNS.some((p) => id.includes(p));
}

/**
 * Add an Anthropic-style cache breakpoint to a message. Handles both the
 * string-content form (common in openai-completions) and the array form
 * (common in anthropic-messages and image-bearing openai-completions).
 *
 * Mutates the message in place and returns true iff a marker was placed.
 */
function stampCacheControlOnMessage(message: Record<string, unknown>, marker: Record<string, unknown>): boolean {
  const content = message.content;
  if (typeof content === 'string') {
    if (content.length === 0) return false;
    message.content = [{ type: 'text', text: content, cache_control: marker }];
    return true;
  }
  if (Array.isArray(content) && content.length > 0) {
    // Walk backwards and stamp the last text/image/tool part. If we find a
    // part that already has cache_control, don't double-stamp.
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i] as Record<string, unknown>;
      if (!part || typeof part !== 'object') continue;
      if (part.cache_control) return true;
      if (
        part.type === 'text' ||
        part.type === 'image' ||
        part.type === 'image_url' ||
        part.type === 'tool_use' ||
        part.type === 'tool_result'
      ) {
        part.cache_control = marker;
        return true;
      }
    }
  }
  return false;
}

/**
 * Apply the OpenCode CLI "2 system + 2 final" caching strategy to the
 * message array. This is the single most important piece: it creates
 * multiple cache breakpoints so the cache is still useful when the last
 * user message changes (which is every turn).
 */
function applyConversationCacheBreakpoints(
  messages: Array<Record<string, unknown>>,
  marker: Record<string, unknown>,
): void {
  // Up to 2 system/developer messages from the front.
  let systemStamped = 0;
  for (const msg of messages) {
    const role = msg.role;
    if (role === 'system' || role === 'developer') {
      if (stampCacheControlOnMessage(msg, marker)) {
        systemStamped += 1;
        if (systemStamped >= 2) break;
      }
    } else {
      break;
    }
  }
  // Last 2 user/assistant messages from the end.
  let finalStamped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = msg.role;
    if (role === 'user' || role === 'assistant') {
      if (stampCacheControlOnMessage(msg, marker)) {
        finalStamped += 1;
        if (finalStamped >= 2) break;
      }
    }
  }
}

function applyOpenAICompletionsCacheControl(payload: Record<string, unknown>, marker: Record<string, unknown>): void {
  const messages = payload.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    applyConversationCacheBreakpoints(messages as Array<Record<string, unknown>>, marker);
  }
  // Tools: stamp the last tool so the tool schema is cached too.
  const tools = payload.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const lastTool = tools[tools.length - 1] as Record<string, unknown>;
    if (lastTool && typeof lastTool === 'object') {
      lastTool.cache_control = marker;
    }
  }
}

function applyAnthropicCacheControl(payload: Record<string, unknown>, marker: Record<string, unknown>): void {
  // System prompt: string or array of text blocks.
  const system = payload.system;
  if (typeof system === 'string') {
    if (system.length > 0) {
      payload.system = [{ type: 'text', text: system, cache_control: marker }];
    }
  } else if (Array.isArray(system) && system.length > 0) {
    // Mirror the 2-block budget used for conversation messages.
    let stamped = 0;
    for (let i = 0; i < system.length && stamped < 2; i++) {
      const part = system[i] as Record<string, unknown>;
      if (part && part.type === 'text') {
        part.cache_control = marker;
        stamped += 1;
      }
    }
  }
  // Conversation messages.
  const messages = payload.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    applyConversationCacheBreakpoints(messages as Array<Record<string, unknown>>, marker);
  }
  // Tools.
  const tools = payload.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const lastTool = tools[tools.length - 1] as Record<string, unknown>;
    if (lastTool && typeof lastTool === 'object') {
      lastTool.cache_control = marker;
    }
  }
}

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
      // Also clear markers nested within tool_result inner content
      if (p.type === 'tool_result' && Array.isArray(p.content)) {
        clearContent(p.content);
      }
    }
  };
  if (Array.isArray(payload.messages)) {
    for (const msg of payload.messages as Array<Record<string, unknown>>) {
      clearContent(msg.content);
    }
  }
  clearContent(payload.system);
  if (Array.isArray(payload.tools)) {
    for (const tool of payload.tools as Array<Record<string, unknown>>) {
      if (tool.cache_control && typeof tool.cache_control === 'object') {
        const cc = tool.cache_control as Record<string, unknown>;
        if (cc.type === 'ephemeral') delete tool.cache_control;
      }
    }
  }
}

/**
 * Extract cache usage tokens from an assistant message's usage object.
 * Handles both anthropic-messages ({cache_read_input_tokens}) and
 * openai-completions ({prompt_tokens_details.cached_tokens}) formats.
 * Returns null if no cache data is present or the data is unparseable.
 */
function extractUsageTokens(usage: unknown): { cachedTokens: number; inputTokens: number } | null {
  if (!usage || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  // Pi normalizes usage: cacheRead (cache hits) + input (fresh tokens only).
  // Total input = cacheRead + input since cacheRead counts toward total input too.
  if (typeof u.cacheRead === 'number' && typeof u.input === 'number') {
    return { cachedTokens: u.cacheRead, inputTokens: u.cacheRead + u.input };
  }
  return null;
}

export default function (pi: ExtensionAPI): void {
  let lastStatusKey: string | undefined;
  const setStatus = (ctx: { ui: { setStatus: (k: string, v: string) => void } }, key: string, value: string): void => {
    if (lastStatusKey && lastStatusKey !== key) {
      ctx.ui.setStatus(lastStatusKey, '');
    }
    lastStatusKey = key;
    ctx.ui.setStatus(key, value);
  };

  // Keep the footer status in sync with the active model immediately when
  // the user switches models. This avoids the visual staleness where the
  // footer still shows the previous API after a model change.
  pi.on('model_select', (event, ctx) => {
    if (!ctx.hasUI) return;
    const model = event.model as { provider?: string; api?: string } | undefined;
    if (!isOpencodeGoModel(model)) {
      if (lastStatusKey) {
        ctx.ui.setStatus(lastStatusKey, '');
        lastStatusKey = undefined;
      }
      return;
    }
    setStatus(ctx, 'opencode-go-cache', 'opencode-go-cache: --');
  });

  pi.on('before_provider_request', (event, ctx) => {
    // The whole body is wrapped in a try/catch so that a bug here can
    // never break the LLM call. Worst case: the request goes out
    // unchanged (caching skipped for this turn) and the user still
    // gets an answer.
    try {
      const model = ctx.model as { provider?: string; baseUrl?: string; api?: string; id?: string } | undefined;
      if (!isOpencodeGoModel(model)) {
        // Clear status when switching to a non-opencode-go model.
        if (lastStatusKey && ctx.hasUI) {
          ctx.ui.setStatus(lastStatusKey, '');
          lastStatusKey = undefined;
        }
        return undefined;
      }
      if (isUnsupportedForCache(model)) {
        // Downstream API rejects Anthropic-style cache markers. Bail
        // out early so the request goes out unchanged.
        if (lastStatusKey && ctx.hasUI) {
          ctx.ui.setStatus(lastStatusKey, '');
          lastStatusKey = undefined;
        }
        if (ctx.hasUI) {
          ctx.ui.setStatus('opencode-go-cache', 'opencode-go-cache: unsupported');
          lastStatusKey = 'opencode-go-cache';
        }
        return undefined;
      }

      const payload = event.payload;
      if (!payload || typeof payload !== 'object') return undefined;
      const payloadObj = payload as Record<string, unknown>;
      const api = model?.api;

      // Stable, per-session cache key. Pi's session id is a uuidv7 so
      // collisions are impossible and the clamp is a defensive no-op.
      const sessionId = ctx.sessionManager.getSessionId();
      const cacheKey = clampPromptCacheKey(sessionId);
      if (cacheKey) {
        payloadObj.prompt_cache_key = cacheKey;
        // 24h retention keeps the cache alive across long Pi sessions.
        // The gateway accepts "24h" for openai-completions and the
        // "1h" ttl for anthropic-style cache_control markers.
        payloadObj.prompt_cache_retention = '24h';
      }

      // Wipe any stale markers from previous turns so the breakpoints
      // land exactly where we want them this turn.
      stripStaleCacheControl(payloadObj);

      if (api === 'openai-completions') {
        applyOpenAICompletionsCacheControl(payloadObj, CACHE_CONTROL_EPHEMERAL);
      } else if (api === 'anthropic-messages') {
        applyAnthropicCacheControl(payloadObj, CACHE_CONTROL_EPHEMERAL);
      }
      // Unknown api: leave the payload as-is (still benefits from
      // prompt_cache_key + 24h retention).

      return payloadObj;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (ctx.hasUI) {
        ctx.ui.notify(`opencode-go-cache: ${msg} (request sent without caching)`, 'warning');
      }
      return undefined;
    }
  });

  pi.on('message_end', (event, ctx) => {
    try {
      if (!ctx.hasUI) return;
      const msg = event.message as { role?: string; usage?: unknown } | undefined;
      if (!msg || msg.role !== 'assistant') return;
      const model = ctx.model as { provider?: string } | undefined;
      if (!model || !PROVIDER_IDS.includes(model.provider)) return;
      if (isUnsupportedForCache(model as { id?: string; provider?: string })) return;
      const tokens = extractUsageTokens(msg.usage);
      if (tokens === null) {
        setStatus(ctx, 'opencode-go-cache', 'opencode-go-cache: --');
        return;
      }
      cacheStats.totalInputTokens += tokens.inputTokens;
      cacheStats.totalCacheHitTokens += tokens.cachedTokens;

      // Cumulative percentage
      const cuRaw = cacheStats.totalInputTokens > 0
        ? Math.round((cacheStats.totalCacheHitTokens / cacheStats.totalInputTokens) * 100)
        : 0;
      const cuPct = Number.isFinite(cuRaw) ? cuRaw : 0;

      // Per-message percentage (this response only)
      const tbRaw = Math.round((tokens.cachedTokens / tokens.inputTokens) * 100);
      const tbPct = Number.isFinite(tbRaw) ? tbRaw : 0;

      const label = cacheStats.totalInputTokens > 0
        ? `opencode-go-cache: CU${cuPct}% TB${tbPct}%`
        : 'opencode-go-cache: --';
      setStatus(ctx, 'opencode-go-cache', label);
    } catch {
      // Silently ignore — never break the LLM flow.
    }
  });

  // Drop the status when the session ends so we don't leave a stale
  // entry on the next session's footer.
  pi.on('session_shutdown', (_event, ctx) => {
    cacheStats.totalInputTokens = 0;
    cacheStats.totalCacheHitTokens = 0;
    if (lastStatusKey && ctx.hasUI) {
      ctx.ui.setStatus(lastStatusKey, '');
      lastStatusKey = undefined;
    }
  });
}
