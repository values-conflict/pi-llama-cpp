# Plan #7 — Prompt Timing Persistence (`promptTokens`, `promptMs`)

## Goal

Capture final prompt token count and duration at the end of prefill, then display them as post-generation stats (e.g., "Prompt: 150 tokens, 234ms"). Currently we discard this data when generation starts.

## What We Already Have

- During prefill, `onPromptProgress()` receives `{ total, processed, time_ms }` on every SSE chunk
- The last prefill event has the final values: `processed == total`, `time_ms` = full prompt eval duration
- When we transition to generation phase (`prefillComplete`), these values are overwritten by reset logic

## Changes to `inference-status.ts`

### 1. Add module-level variables for persisted prompt stats

```ts
let finalPromptTokens: number | null = null;
let finalPromptMs: number | null = null;
```

### 2. Capture at prefill completion boundary

In `onPromptProgress()`, when we detect the last prefill event (`processed >= total`), save it before generation takes over:

```ts
if (total && processed !== undefined && processed >= total) {
    finalPromptTokens = processed;
    finalPromptMs = timeMs ?? null;
}
```

### 3. Reset on new request

In `resetForNewRequest()`:
```ts
finalPromptTokens = null;
finalPromptMs = null;
```

### 4. Display in post-generation stats

Modify `getStatsMessage()` to include prompt timing alongside generation stats:

**Current output:**
```
🤔 42.1 tok/s · 15 tokens in 0.4s
```

**With prompt timing appended (after stream completes):**
```
Prompt: 150t / 234ms · Gen: 15t / 0.4s @ 42.1 tok/s
```

Or during active generation, keep the current format and add a brief summary line only after `[DONE]`.

## Where to Show It

Two options:

**A) In the working message (during + after generation):** Add prompt stats as a prefix or suffix to the existing generation stats line. Works but clutters the live TPS display.

**B) As a final summary on stream end:** When we detect `[DONE]` / reader done, show one last working message with full stats:
```
Done · Prompt: 150t / 234ms (89 cached) · Gen: 15t / 0.4s @ 42.1 tok/s
```
Then clear after a brief delay or on next turn start.

## Open Questions

1. **Display format:** One line vs two? Compact notation (`150t`) vs verbose ("150 tokens")? The working message is single-line in Pi's UI — need to keep it readable.
2. **Timing accuracy:** `time_ms` from prompt_progress is wall-clock on the server side, not GPU-only time. Upstream uses `prompt_ms` from timings which may differ slightly. Our data source (`chunk.prompt_progress.time_ms`) matches what upstream shows during prefill — should be fine for display purposes.
