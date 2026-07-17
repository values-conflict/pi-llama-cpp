# Plan #8 — Prediction Timing Persistence (`predicted_n`, `predicted_ms`)

## Goal

Persist final generation stats (token count + duration) so they survive stream end and can be shown as post-generation summary. Currently tracked live in `genPredictedN` / `genPredictedMs` but lost when we reset for the next request.

## What We Already Have

- During generation, `onTimings()` receives `{ predicted_n, predicted_ms }` on every SSE chunk
- These are cumulative — last values = final totals
- Stored in module-level `genPredictedN`, `genPredictedMs` but reset immediately when next request starts

## Changes to `inference-status.ts`

### 1. Add persisted variables (parallel to #7's prompt timing)

```ts
let finalPredictedTokens: number | null = null;
let finalPredictedMs: number | null = null;
```

### 2. Capture at stream end

When the SSE reader resolves `done: true` in our ReadableStream, save current values before reset:

In `captureTimings()`, after the read loop ends (before controller.close()):
```ts
// Stream ended — persist final generation stats
if (hasGenerationData) {
    finalPredictedTokens = genPredictedN;
    finalPredictedMs = genPredictedMs;
}
this.showFinalSummary(); // optional: display one last message with full stats
```

### 3. Reset on new request

In `resetForNewRequest()`:
```ts
finalPredictedTokens = null;
finalPredictedMs = null;
```

### 4. Combine with prompt timing for final summary

When both #7 (prompt) and this (#8) are implemented, the full post-generation line becomes:
```
Done · Prompt: 150t / 234ms · Gen: 15t / 0.4s @ 42.1 tok/s
```

## Relationship to #7 (Prompt Timing)

These two plans are tightly coupled — both persist timing data at stream boundaries and display it together in a final summary line. They could be implemented as one PR or separately:
- **#7 alone:** Show prompt stats after generation starts ("Prefill done, 150t / 234ms · now generating...")
- **#8 alone:** Show generation stats briefly on stream end before clearing
- **Both together:** Full summary line with both phases

## Open Questions

1. **How long to show the final summary?** Options: clear immediately when Pi fires `onTurnEnd`, keep for N seconds, or leave until next request starts (our current reset clears it).
2. **Should we expose these via a public getter** so other parts of the extension could use them? Currently everything is private/module-level — adding `getLastPromptTiming()` / `getLastPredictionTiming()` would let future features access historical stats without re-parsing SSE.
