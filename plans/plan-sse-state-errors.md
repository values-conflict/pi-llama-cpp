# Plan #11+15 — SSE Connection State & Error Display (merged)

## Goal

Monitor SSE stream health and surface connection state/errors in the working message progress line. Currently we don't track whether the stream is healthy, reconnecting, or lost — errors are silently swallowed by try/catch blocks.

## Upstream States We Can Mirror

| State | Meaning | How to Detect |
|-------|---------|---------------|
| `STREAMING` | Normal active connection | First byte received from SSE reader; ongoing chunks flowing |
| `RESUMING` | Inner reader ended, replay request made for missing data | Reader resolves with `done: true` but we haven't seen `[DONE]`; upstream fires a second fetch to `/v1/chat/completions?replay=true&last_id=...` |
| `LOST` | Resume produced no new bytes or failed entirely | Replay stream returns empty/error; connection irrecoverably broken |

## What We Can Detect From Our Position

We intercept at the `fetch()` level and wrap the response body in a ReadableStream. This gives us visibility into:

1. **Initial fetch failure** — our interceptor's try/catch already catches this, but swallows errors
2. **Reader resolution** — when `.read()` returns `{ done: true }`, we know the stream ended
3. **Chunk parsing failures** — malformed SSE lines or JSON parse errors in `onTimings`/`onPromptProgress`

What we *can't* easily do without significant changes:
- Replay/resume logic (upstream's inner reader pattern with replay fetches)
- Distinguish between "server ended stream normally" vs "connection dropped mid-stream" — both look like `{ done: true }` to us

## Proposed Implementation

### 1. Add connection state tracking in `captureTimings()`

```ts
type ConnectionState = 'active' | 'ended-cleanly' | 'ended-abruptly' | 'error';
let _connectionState: ConnectionState | null = null;
```

- Set to `'active'` when first chunk arrives
- On reader `{ done: true }`: if we saw `[DONE]`, set `'ended-cleanly'`; otherwise `'ended-abruptly'`
- On fetch/parse error: set `'error'` with stored error message

### 2. Surface in working message

| State | Display |
|-------|---------|
| `active` | Normal progress line (no change) |
| `ended-cleanly` | Show final summary, then clear (current behavior) |
| `ended-abruptly` | "⚠ Stream ended unexpectedly — response may be incomplete" |
| `error` | "❌ Connection error: [message]" |

### 3. Error capture in interceptor

In our fetch wrapper (`ensureStreamOptions`), catch errors and store them:
```ts
try {
    // ... existing intercept logic
} catch (err) {
    this.lastError = err instanceof Error ? err.message : String(err);
    this._connectionState = 'error';
    throw err; // still propagate so Pi handles retry/fallback
}
```

## Changes to `inference-status.ts`

1. Add `_connectionState` field and `lastError: string | null`
2. In `captureTimings()` read loop, track whether `[DONE]` was seen before reader ended
3. On stream end, call a new method that shows appropriate message based on state
4. Reset both fields in `resetForNewRequest()`

## Open Questions

1. **How long to show error messages?** Should they persist until next request starts (current reset behavior), or auto-clear after N seconds? Errors are important — user should see them.
2. **"Ended abruptly" detection:** If the server sends `[DONE]` but our reader still gets `{ done: true }`, that's normal. The tricky case is when network drops mid-stream and Pi retries silently — we might show "ended abruptly" for a retry that succeeds immediately. Could add a small delay (e.g., 2s) before showing the warning, only display if no new stream starts.
3. **Replay/resume awareness:** Upstream's resume logic is in `chat.service.ts` and involves inner reader patterns we don't replicate. Without replay support, "resuming" state doesn't apply to us — just active/ended/error.
