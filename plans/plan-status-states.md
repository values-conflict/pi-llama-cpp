# Plan #5 — Generation Status States + Queue Detection

## Goal

Define a typed set of inference phases we can detect from SSE data and server endpoints, then present them meaningfully in the working message progress line.

## Detectable Phases

| Phase | How We Know | Signal Source |
|-------|-------------|---------------|
| `queued` | Server has no idle slots; our request is waiting | Poll `GET /slots` → `deferred > 0` or `idle == 0`. Requires server started with `--slots`. |
| `prefilling` | Receiving `prompt_progress` SSE events where `processed < total` | Already detected in our code via `chunk.prompt_progress` |
| `generating` | Prefill complete (`processed >= total`) and receiving `timings` with `predicted_n > 0` | Already detected implicitly; needs formal state transition |
| `done` | Stream ended (reader done, `[DONE]` received) | Detectable when our ReadableStream reader resolves `done: true` |

### What about "queued"?

llama.cpp server exposes slot metrics via `GET /slots`:
```json
{
  "idle": 1,        // slots not processing anything
  "processing": 0,   // slots actively running inference
  "deferred": 2      // tasks queued behind active slots
}
```

**Problem:** By the time our fetch interceptor fires, the request has already been sent to the server. We can't easily poll `/slots` *before* the chat completion call because we intercept at `fetch()` level — Pi's provider layer makes the call and we wrap it.

**Options for queue detection:**
1. **Poll before intercepting:** Hook into Pi's `onBeforeProviderRequest` event (already exists in our `EventManager`) to poll `/slots` first, then set a "queued" state if needed. This adds latency but is accurate.
2. **Detect from timing gap:** If we send the request and don't receive any SSE data for > N seconds, infer "waiting." Less precise but no extra round-trip.
3. **Skip queue detection** — it's rare in single-user setups (n_parallel=1 means at most 1 queued). Focus on prefill/generating/done instead.

## Proposed State Enum

```ts
export type InferencePhase = 'queued' | 'prefilling' | 'generating' | 'done';
```

Each phase maps to a working message format:
- `queued` → "⏳ Waiting for GPU..." (only if we detect it)
- `prefilling` → Current bar + ETA + TPS (already implemented)
- `generating` → Current stats line with tok/s + token count (already implemented)
- `done` → Clear working message (already done in `onTurnEnd`)

## Changes to `inference-status.ts`

1. Add `InferencePhase` type and a private `_phase: InferencePhase | null` field
2. Transition states explicitly:
   - Reset → phase = null on new request start (`resetForNewRequest`)
   - First SSE bytes received but no prompt_progress yet → could be queued (optional)
   - `prompt_progress` with `processed < total` → `'prefilling'`
   - Prefill complete + first timings chunk → `'generating'`
   - Stream ends (`done: true` in reader) → `'done'`, clear working message
3. Optional: In `EventManager.onBeforeProviderRequest`, poll `/slots` and set initial phase to `'queued'` if deferred > 0

## Changes to display logic

- `getProgressMessage()` already branches on prefill vs generation — just needs the formal state variable for clarity
- Add a "Waiting..." message variant if queue detection is enabled
- No breaking changes to existing bar/stats output

## Open Questions

1. **Queue detection priority:** Is it worth adding? For single-user (n_parallel=1), deferred tasks are rare and brief. The timing-gap heuristic (#2 above) might be enough without a separate `/slots` poll.
2. **"done" state duration:** Should we show final stats briefly before clearing, or clear immediately on stream end? Currently `onTurnEnd` clears — but that fires after Pi processes the response, not when SSE ends.
