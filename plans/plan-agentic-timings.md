# Plan #12 — Agentic Flow Timings (`ChatMessageAgenticTimings`)

## Goal

Track timing data across multiple turns in agentic/tool-use conversations: total turns, tool call counts, time spent in tools vs LLM inference. Currently each turn resets state independently — we lose the cumulative picture of an agent loop.

## What Upstream Tracks

From `ChatMessageAgenticTimings` type definition:
- Total number of turns (LLM invocations)
- Number of tool calls across all turns
- Cumulative time spent in tools vs LLM inference
- Per-tool breakdown with success/failure/duration

Upstream accumulates this via an `onTurnComplete` callback that fires after each turn ends, adding intermediate timings to a running total.

## What We Can Detect From Our Position

We intercept at the fetch level and see every SSE stream independently. Each tool-use conversation produces multiple sequential streams:
1. User prompt → LLM responds with tool call (stream 1)
2. Tool executes externally (we don't see this timing directly)
3. Tool result + original prompt → LLM continues or calls another tool (stream 2)
4. ... repeats until final response

**What we can measure:** Each stream's prefill time, generation time, token counts — per-turn data that already exists in our code but resets between turns.

**What we can't easily see:** Tool execution duration (happens outside the SSE stream), tool success/failure status, which tools were called. Pi handles this via its extension API events (`onToolCall`, `onToolResult`).

## Proposed Approach

### Option A: Aggregate per-turn stats across streams
- Don't reset timing data on new request; instead accumulate into a "conversation session" bucket
- Track turn count incrementally each time we see a new stream start for the same conversation
- Show cumulative line during agent loops: "Turn 3/5 · Total gen: 120t / 4.2s @ 28.6 tok/s avg"

### Option B: Integrate with Pi's tool events (preferred)
- Listen to `onToolCall` and `onToolResult` from Pi's event system
- Measure wall-clock time between call → result for each tool
- Combine with our per-turn LLM timings for full picture
- Show multi-phase progress during agent loops

### Option C: Lightweight turn counter only
- Simplest option: just count how many SSE streams we've seen since the original user message
- Display "Turn N" in working message alongside normal stats (don't reset between turns)
- No tool timing, no cumulative aggregation — just awareness that an agent loop is happening

## Recommendation

**Start with Option C** as a quick win. It requires minimal changes:
1. Add `turnCount` field to inference status module
2. Increment on each new stream start (detect via `resetForNewRequest()` or first chunk of new SSE)
3. Show "Turn N" prefix in working message during generation

If Pi's event API exposes tool call/result events, upgrade to Option B later for full agentic timing breakdowns.

## Changes to `inference-status.ts` (Option C)

```ts
let turnCount: number = 0;

// In captureTimings() or on first chunk of new stream:
turnCount++;

// In getStatsMessage():
if (turnCount > 1) {
    return `Turn ${turnCount} · 🤔 ${tps.toFixed(1)} tok/s ...`;
}
```

Reset turn count when we detect a brand-new user message (not an agent continuation). This is the tricky part — distinguishing "same conversation, new agent turn" from "user sent a fresh prompt." May need Pi's event system to know this reliably.
