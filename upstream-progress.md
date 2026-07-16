# Upstream Progress & Status Tracking Report — `chat.svelte.ts`

Source: [`tools/ui/src/lib/stores/chat.svelte.ts`](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts)

---

## 1. Prompt Processing Progress Bar (`prompt_progress`)

**What it shows:** How many prompt tokens have been evaluated out of the total batch, including how many came from KV cache vs actual computation. Drives a percentage progress bar during the "preparing" phase before token generation starts.

- `onTimings` callback receives and forwards `promptProgress`: [L1179–L1190](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1179-L1190) (streamChatCompletion), [L1902–L1913](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1902-L1913) (continueAssistantMessage)
- `parseTimingData` computes `progressPercent` from it: [L2255–L2268](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2255-L2268)

## 2. Tokens/Second Throughput (`tokensPerSecond`)

**What it shows:** Live inference speed during token generation, computed as `(predicted_n / predicted_ms) * 1000`. Updated on every `onTimings` callback throughout the stream.

- Computed in `streamChatCompletion.onTimings`: [L1179–L1181](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1179-L1181)
- Computed in `continueAssistantMessage.onTimings`: [L1902–L1904](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1902-L1904)
- Stored on `ApiProcessingState.tokensPerSecond`: [L2253](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2253), [L2278](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2278)

## 3. Token Counters (Decoded & Remaining)

**What it shows:** How many output tokens have been generated so far (`tokensDecoded`), and how many are left before hitting `max_tokens` (`tokensRemaining`). Drives a "X / Y tokens" counter or progress indicator.

- Computed in `parseTimingData`: [L2271–L2276](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2271-L2276)

## 4. Context Window Usage Bar (`contextUsed` / `contextTotal`)

**What it shows:** How many of the model's total context slots are consumed by the current conversation (prompt tokens + cache hits + predicted tokens). Drives a "context used" progress bar.

- `getContextTotal()` resolves from processing state or config: [L2203–L2225](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2203-L2225)
- `contextUsed` computed in `parseTimingData`: [L2261](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2261), [L2273–L2274](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2273-L2274)

## 5. Generation Status States (`status`)

**What it shows:** The current phase of inference:
- `preparing` — prompt is being evaluated (prompt progress bar active)
- `generating` — tokens are streaming out (tokens/sec counter active)
- `idle` / `initializing` — between turns

- Derived in `parseTimingData`: [L2270](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2270)

## 6. Cache Hit Tracking (`cacheTokens`)

**What it shows:** How many prompt tokens were served from KV cache vs re-computed. Useful for showing "X cached / Y new" breakdowns.

- Extracted in `parseTimingData`: [L2254](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2254), [L2286](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2286)
- Forwarded from `onTimings` callbacks: [L1189](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1189), [L1912](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1912)

## 7. Prompt Timing (`promptTokens`, `promptMs`)

**What it shows:** Total time spent evaluating the prompt and how many tokens were in it. Shown as post-generation stats (e.g., "Prompt: 150 tokens, 234ms").

- Extracted in `parseTimingData`: [L2250–L2251](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2250-L2251), [L2284–L2285](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2284-L2285)
- Forwarded from `onTimings` callbacks: [L1185–L1186](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1185-L1186), [L1908–L1909](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1908-L1909)

## 8. Prediction Timing (`predicted_n`, `predicted_ms`)

**What it shows:** Total time and token count for the generation phase itself (post-prompt). Shown as post-generation stats (e.g., "Generation: 42 tokens, 1.8s"). Also persisted on messages via `ChatMessageTimings`.

- Forwarded from `onTimings` callbacks: [L1187–L1188](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1187-L1188), [L1910–L1911](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1910-L1911)
- Persisted on message in `savePartialResponseIfNeeded`: [L1526–L1532](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1526-L1532)

## 9. Loading / Spinner States (per-conversation)

**What it shows:** Boolean flags that drive spinner indicators in the sidebar and chat area for each conversation independently. Distinguishes between "this browser started it" vs "another tab/device has a running session."

- State declarations: [L80–L91](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L80-L91)
- `setChatLoading` (local pipe): [L118–L133](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L118-L133)
- `remoteRunningConvs` (cross-device sessions): [L90](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L90), [L641–L696](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L641-L696)
- `getAllLoadingChats` (union of local + remote): [L623–L629](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L623-L629)

## 10. Reasoning (Chain-of-Thought) State (`isReasoning`)

**What it shows:** Whether the model is currently emitting reasoning/thinking content vs visible output. Drives a "thinking…" indicator or collapsible reasoning panel.

- State declarations: [L76–L78](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L76-L78)
- `setChatReasoning`: [L135–L143](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L135-L143)
- Toggled by `onReasoningChunk` / `onChunk`: [L1163–L1169](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1163-L1169)

## 11. Stream Connection State (`streamConnectionState`)

**What it shows:** Whether the SSE connection is healthy, reconnecting to a replay stream, or irrecoverably lost. Drives reconnection UI hints.

- Declaration: [L80](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L80)
- Updated via `onConnectionState` callbacks: [L1376–L1379](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1376-L1379) (streamChatCompletion), [L1872–L1875](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1872-L1875) (continueAssistantMessage), [L426–L429](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L426-L429) (attachServerStream)

## 12. Agentic Flow Timings (`ChatMessageAgenticTimings`)

**What it shows:** For agentic/tool-use conversations: total turns, number of tool calls, time spent in tools vs LLM inference, and per-tool breakdown with success/failure/duration. Drives a multi-phase progress display during agent loops.

- `onTurnComplete` callback accumulates intermediate timings across turns: [L1173–L1178](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1173-L1178)
- Type definition (in `types/chat.d.ts`): [`ChatMessageAgenticTimings`](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/types/chat.d.ts#L61-L73)

## 13. Temperature & Top-P Display (`temperature`, `topP`)

**What it shows:** The sampling parameters used for the generation (informational, not dynamic). Read from current config and stored on processing state.

- Stored in `parseTimingData`: [L2279–L2280](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2279-L2280)
- Sent to API in `getApiOptions`: [L2341–L2342](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2341-L2342)

## 14. Pending Message Queue Indicator (`hasPendingMessage`)

**What it shows:** Whether a user's follow-up message is queued behind an active stream. Drives a "message waiting" or "send immediately" UI affordance.

- State declaration: [L110–L113](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L110-L113)
- Queue check in `sendMessage`: [L978–L981](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L978-L981)
- Accessor methods: [L716–L744](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L716-L744)

## 15. Error Dialog State (`errorDialogState`)

**What it shows:** Context-aware error popups (e.g., "context window exceeded" with token counts). Carries `type` ('TIMEOUT' | 'SERVER'), message text, and optional overflow context info.

- Declaration: [L74](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L74)
- `showErrorDialog` / `dismissErrorDialog`: [L574–L579](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L574-L579)
- Shown on streaming errors with context info: [L1049–L1059](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1049-L1059) (sendMessage), [L1320–L1332](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1320-L1332) (onError callback), [L1992–L1997](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1992-L1997) (continueAssistantMessage onError)

---

## Summary Table

| # | Metric / Indicator | Key Lines in `chat.svelte.ts` |
|---|---|---|
| 1 | Prompt processing progress bar | [L1179–L1190](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1179-L1190), [L2255–L2268](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2255-L2268) |
| 2 | Tokens/sec throughput | [L1179–L1181](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1179-L1181), [L2253](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2253), [L2278](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2278) |
| 3 | Token counters (decoded / remaining) | [L2271–L2276](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2271-L2276) |
| 4 | Context window usage bar | [L2203–L2225](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2203-L2225), [L2261](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2261), [L2273–L2274](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2273-L2274) |
| 5 | Generation status states | [L2270](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2270) |
| 6 | Cache hit tracking | [L1189](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1189), [L2254](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2254), [L2286](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2286) |
| 7 | Prompt timing (tokens + ms) | [L1185–L1186](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1185-L1186), [L2250–L2251](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2250-L2251), [L2284–L2285](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2284-L2285) |
| 8 | Prediction timing (tokens + ms) | [L1187–L1188](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1187-L1188), [L1526–L1532](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1526-L1532) |
| 9 | Loading / spinner states | [L80–L91](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L80-L91), [L118–L133](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L118-L133), [L623–L629](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L623-L629) |
| 10 | Reasoning (CoT) state | [L76–L78](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L76-L78), [L135–L143](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L135-L143), [L1163–L1169](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1163-L1169) |
| 11 | Stream connection state | [L80](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L80), [L1376–L1379](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1376-L1379), [L1872–L1875](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1872-L1875) |
| 12 | Agentic flow timings | [L1173–L1178](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1173-L1178) |
| 13 | Temperature & Top-P display | [L2279–L2280](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L2279-L2280) |
| 14 | Pending message queue indicator | [L110–L113](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L110-L113), [L716–L744](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L716-L744) |
| 15 | Error dialog state | [L74](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L74), [L574–L579](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L574-L579), [L1049–L1059](https://github.com/ggml-org/llama.cpp/blob/0c4fa7a989f94a9fef9e52a887e3376bb60d0848/tools/ui/src/lib/stores/chat.svelte.ts#L1049-L1059) |
