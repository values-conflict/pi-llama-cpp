# Plan #6 — Cache Hit Tracking (`cacheTokens`)

## Goal

Parse `timings.cache_n` from SSE chunks and display cache hit info during prefill, so the user sees "X cached / Y new" breakdowns. Also use it to adjust the progress bar: actual work = processed - cached (matching upstream behavior).

## What We Already Have

- Our `onPromptProgress()` receives `{ total, processed, time_ms }` from `chunk.prompt_progress`
- Upstream's `prompt_progress` also includes a `cache` field: `{ total, cache, processed, time_ms }`
- Separately, each generation-phase SSE chunk carries `timings.cache_n` (total cached tokens for the full request)

## Data Sources

| Field | Where | When Available |
|-------|-------|---------------|
| `prompt_progress.cache` | In every prefill progress event | During prefill — cumulative cache hits so far |
| `timings.cache_n` | In every generation timings chunk | After prefill completes — final total |

## Changes to `inference-status.ts`

### 1. Parse `cache` from prompt_progress events

In `onPromptProgress()`, extract the `cache` field:

```ts
const cache = p.cache as number | undefined; // already in upstream SSE format
currentProgress = { total, processed, time_ms, cache };
```

Update the type of `currentProgress`:
```ts
let currentProgress: { total?: number; processed?: number; time_ms?: number; cache?: number } | null = null;
```

### 2. Adjust progress bar to reflect actual work (not cached tokens)

Upstream computes:
```js
progressCache = promptProgress?.cache || 0,
progressActualDone = (promptProgress?.processed ?? 0) - progressCache,
progressActualTotal = (promptProgress?.total ?? 0) - progressCache;
progressPercent = Math.round((progressActualDone / progressActualTotal) * 100);
```

Our current bar uses `processed / total` directly. Change to `(processed - cache) / (total - cache)` so the bar reflects real computation, not fast cache lookups.

### 3. Show "cached" suffix in prefill message

After the progress bar and TPS, append cache info:
```
Prefilling... ████████░░░░░░░░░░ 40% · 2s · 156.3 tok/s · 89 cached / 127 new
```

Or more compactly if space is tight:
```
Prefilling... ████░░░░░░░░░░░░░░░░ 40% · 2s · 156.3 tok/s (89 cached)
```

### 4. Show final cache count in generation stats

When transitioning to generation phase, we know the total `cache_n` from timings. Could append it:
```
🤔 42.1 tok/s · 15 tokens in 0.4s (89 cached)
```

## Open Questions

1. **Display priority:** Cache info is useful but clutters the line. Should it always show, or only when cache > 0? Upstream shows "X cached / Y new" as part of a richer UI panel — we have one line. Maybe: `(89 cached)` suffix only during prefill, drop after generation starts (or keep briefly).
2. **Progress bar semantics:** Adjusting to actual work means the bar jumps when cache hits are discovered mid-prefill (e.g., first 50 tokens all cached → bar stays at 0% until uncached tokens start). This matches upstream but could look jarring. Alternative: show two bars or keep current behavior and just add text suffix.
