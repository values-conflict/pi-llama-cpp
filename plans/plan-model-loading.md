# Plan #9 — Model Loading Progress

## Goal

Show model loading progress (percentage, speed MB/s, ETA) instead of just a toast notification at start/end. This happens *before* any SSE stream starts — it's about the server loading weights into GPU/CPU memory.

## What We Know About llama.cpp Server API

- `GET /v1/models` returns model info including state (`loaded`, `loading`, `unloaded`)
- Router mode has `/models/load` and `/models/unload` endpoints
- The server logs "model loaded" after loading completes — no streaming progress endpoint exists in standard mode
- In router mode, the models API may expose download progress via `loaded_info` field (commented TODO for download)

## Feasibility Assessment

**Standard single-model server:** No progress endpoint. Loading is synchronous at startup; by the time we connect, it's done. Not actionable unless user restarts the server with a different model.

**Router mode / multi-model:** `GET /v1/models` shows state transitions (`loading` → `loaded`). We could poll this to detect when loading starts/ends, but still no percentage/speed data from the server itself.

## Proposed Approach (if feasible)

### Option A: Poll `/v1/models` for state changes
- On model select event, start polling `GET /v1/models` every 500ms
- When state = `loading`, show "Loading [model]..." in working message
- When state = `loaded`, clear and proceed
- **Limitation:** No percentage or ETA — just a spinner/text indicator

### Option B: Parse server logs (if accessible)
- llama.cpp prints loading progress to stdout during startup
- If we control the server process, could parse log lines for "loading" / "t_load_ms" timing data
- **Limitation:** Requires file access or pipe to server output; not available if user runs server separately

### Option C: Accept current behavior (toast notifications)
- Our `EventManager.onModelSelect` already shows "Loading X..." and "X ready" via Pi's notify API
- This is sufficient for most users since model loading happens once at startup or on explicit switch

## Recommendation

**Start with Option A if router mode is in use**, otherwise accept current toast behavior. The progress bar/percentage data simply doesn't exist in llama.cpp's HTTP API for standard single-model servers. We can detect *that* a model is loading, but not *how far along*.

If we implement Option A:
1. Add polling logic to `EventManager` on model select events
2. Show "⏳ Loading [model]..." as working message while state = `loading`
3. Clear when state transitions to `loaded` or after timeout (e.g., 60s)
