# Upstream Progress & Status Tracking — Remaining Gaps

Source: [`tools/ui/src/lib/stores/chat.svelte.ts`](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts)

---

## Already Covered (removed from scope)

| # | Feature | Reason |
|---|---------|--------|
| ~~1~~ | Prompt processing progress bar | ✅ Implemented in our `inference-status.ts` — prefill bar with ETA + TPS |
| ~~2~~ | Tokens/sec throughput | ✅ Implemented — instantaneous delta-TPS during prefill, `(predicted_n / predicted_ms) * 1000` during generation |
| ~~3~~ | Token counters (decoded / remaining) | Handled by Pi directly |
| ~~4~~ | Context window usage bar | Handled by Pi directly |
| ~~10~~ | Reasoning (CoT) state | Handled by Pi directly |
| ~~14~~ | Pending message queue indicator | Handled by Pi directly |

---

## Remaining Items

### 5. Generation Status States (`status`)

**What it shows:** The current phase of inference, driving different UI indicators per phase:
- `preparing` — prompt is being evaluated (prefill progress bar active)
- `generating` — tokens are streaming out (tokens/sec counter active)
- `idle` / `initializing` — between turns

**Upstream:** Derived in `parseTimingData`: [L2270](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2270)

**Our status:** We distinguish prefill vs generation implicitly (message format changes), but have no formal state enum. No detection of "waiting in queue" or other intermediate states.

**Goal:** Define a typed set of inference phases we can detect from SSE data and present them meaningfully in the progress line. Explore whether llama.cpp exposes slot/queue information (`GET /slots` → `is_processing`) that lets us show "queued — waiting for GPU."

---

### 7. Prompt Timing (`promptTokens`, `promptMs`)

**What it shows:** Total time spent evaluating the prompt and how many tokens were in it. Shown as post-generation stats (e.g., "Prompt: 150 tokens, 234ms").

**Upstream:** Extracted in `parseTimingData`: [L2250–L2251](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2250-L2251), [L2284–L2285](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2284-L2285). Forwarded from `onTimings` callbacks: [L1185–L1186](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1185-L1186), [L1908–L1909](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1908-L1909).

**Our status:** We capture `processed` and `time_ms` during prefill but discard them when generation starts. The final prompt token count + duration are not persisted or displayed after the stream completes.

---

### 6. Cache Hit Tracking (`cacheTokens`)

**What it shows:** How many prompt tokens were served from KV cache vs re-computed. Useful for showing "X cached / Y new" breakdowns during prefill.

**Upstream:** Extracted in `parseTimingData`: [L2254](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2254), [L2286](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2286). Forwarded from `onTimings` callbacks: [L1189](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1189), [L1912](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1912).

**Our status:** We never read `timings.cache_n` from SSE chunks. The data is available — we just don't parse it. Upstream also uses cache to adjust the progress bar: actual work = processed - cached, so the bar reflects real computation not cache hits.

---

### 8. Prediction Timing Persistence (`predicted_n`, `predicted_ms`)

**What it shows:** Total time and token count for the generation phase (post-prompt). Shown as post-generation stats ("Generation: 42 tokens, 1.8s"). Persisted on messages via `ChatMessageTimings`.

**Upstream:** Forwarded from `onTimings` callbacks: [L1187–L1188](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1187-L1188). Persisted on message in `savePartialResponseIfNeeded`: [L1526–L1532](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1526-L1532).

**Our status:** We track `genPredictedN` / `genPredictedMs` live during generation but never persist or expose them after the stream ends. Data is lost when we reset for the next request.

---

### 9. Model Loading Progress

**What it shows:** Progress of a model loading into GPU/CPU memory — percentage, speed (MB/s), ETA. Distinguishes from inference progress entirely; this happens before any SSE stream starts.

**Upstream in chat.svelte.ts:** The `chatLoadingStates` / `remoteRunningConvs` at [L80–L91](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L80-L91) are about *cross-chat spinner states* (which conversations have active streams), not model loading. Model loading progress is handled separately by the server's `/v1/models` endpoint and potentially SSE events during load.

**Our status:** We show "Loading X..." / "X ready" via `ctx.ui.notify()` in `EventManager.onModelSelect`. No percentage, speed, or ETA — just a toast notification at start/end.

---

### 11 + 15. SSE Connection State & Error Display (merged)

**What it shows:** Whether the SSE stream is healthy (`streaming`), reconnecting to a replay stream (`resuming`), or irrecoverably lost (`lost`). Combined with error context: timeout vs server errors, optional overflow info like `n_prompt_tokens / n_ctx`.

**Upstream enums:** [`StreamConnectionState`](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/enums/chat.enums.ts#L17-L20) — `STREAMING | RESUMING | LOST`. [`ErrorDialogType`](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/enums/chat.enums.ts#L64-L67) — `TIMEOUT | SERVER`.

**Upstream connection logic:** The SSE reader in `chat.service.ts` transitions states:
- → `STREAMING` on first byte received and after successful resume [L742, L844](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/services/chat.service.ts#L742)
- → `RESUMING` when inner reader ends and a replay request is made [L938](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/services/chat.service.ts#L938)
- → `LOST` when resume produces no new bytes or fails entirely [L933, L952](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/services/chat.service.ts#L933)

**Upstream error display:** `showErrorDialog` at [L574–L579](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L574-L579) with typed dialogs shown on streaming errors [L1320–L1332](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1320-L1332).

**Our status:** We don't monitor SSE connection health at all. If the stream drops, we just stop updating. Errors from our fetch interceptor are silently swallowed by try/catch blocks. No reconnection awareness.

---

### 12. Agentic Flow Timings (`ChatMessageAgenticTimings`)

**What it shows:** For agentic/tool-use conversations: total turns, number of tool calls, time spent in tools vs LLM inference, and per-tool breakdown with success/failure/duration. Drives a multi-phase progress display during agent loops.

**Upstream:** `onTurnComplete` callback accumulates intermediate timings across turns: [L1173–L1178](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1173-L1178). Type definition: [`ChatMessageAgenticTimings`](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/types/chat.d.ts#L61-L73).

**Our status:** Each turn resets state independently. No multi-turn timing aggregation — we don't track total turns, tool call counts, or cumulative agent-phase breakdowns.

---

### 13. Temperature & Top-P Display (`temperature`, `topP`)

**What it shows:** The sampling parameters used for the generation (informational, not dynamic). Read from current config and stored on processing state.

**Upstream:** Stored in `parseTimingData`: [L2279–L2280](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2279-L2280). Sent to API in `getApiOptions`: [L2341–L2342](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2341-L2342).

**Our status:** We don't read or display sampling parameters at all. Pi sets these on the request; we could extract them from our own `ensureStreamOptions` interceptor payload, but currently ignore them.

---

## Summary Table (remaining items only)

| # | Feature | Our Status | Effort |
|---|---------|------------|--------|
| 5 | Generation status states + queue detection | Implicit prefill/gen split; no formal enum or queue awareness | Medium |
| 6 | Cache hit tracking (`cache_n`) | Data available in SSE, not parsed | Low — quick win |
| 7 | Prompt timing (tokens + ms) | Captured during prefill, discarded after generation starts | Low — save final values |
| 8 | Prediction timing persistence | Tracked live, lost on reset | Low — save final values |
| 9 | Model loading progress | Toast at start/end only; no percentage/speed/ETA | Medium-High (depends on server API) |
| 11+15 | SSE connection state + error display in progress line | No monitoring; errors silently swallowed | Medium |
| 12 | Agentic flow timings | Per-turn reset, no aggregation | High — needs multi-turn tracking |
| 13 | Temperature & Top-P display | Not read or shown | Low — extract from request payload |
