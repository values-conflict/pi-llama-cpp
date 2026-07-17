# Plan #13 — Temperature & Top-P Display (`temperature`, `topP`)

## Goal

Extract sampling parameters from our own request payload and display them in the working message (informational, not dynamic). Currently we ignore these values entirely.

## What We Already Have

- Our fetch interceptor (`ensureStreamOptions` in `EventManager`) wraps every outgoing `/v1/chat/completions` call
- The request body contains `temperature`, `top_p`, and other sampling params set by Pi's provider layer
- These are static per-request — don't change mid-stream

## Changes to `inference-status.ts`

### 1. Capture from interceptor payload

In our fetch wrapper, extract before forwarding:
```ts
const body = await request.json(); // or parse if already cloned
this.samplingParams = {
    temperature: (body.temperature as number) ?? null,
    topP: (body.top_p as number) ?? null,
};
// Re-serialize and forward...
```

### 2. Store in module state

```ts
let samplingParams: { temperature?: number; topP?: number } | null = null;
```

Reset in `resetForNewRequest()`.

### 3. Display option (low priority)

Sampling params are informational and static — showing them clutters the progress line which is already busy with TPS, token counts, cache info, etc. Options:

**A) Append to final summary:** Include alongside prompt/gen timing in post-generation stats:
```
Done · Prompt: 150t / 234ms · Gen: 15t / 0.4s @ 42.1 tok/s (temp=0.8, top_p=0.9)
```

**B) Skip for now:** Low value relative to effort; user can check in Pi's settings/model config if they care.

## Recommendation

**Implement capture (#1 + #2 above), defer display.** The data extraction is trivial and costs nothing — but displaying it competes with higher-value info on a single line. If we ever add a multi-line status panel or tooltip, sampling params become easy to surface from stored state.
