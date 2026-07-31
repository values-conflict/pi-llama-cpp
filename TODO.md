- split provider and stats into separate repositories
  - now complicated by our SSE listener providing us the event that tells us it is time to re-ask the server how big the context is so that when the model finally loads we replace the default 128k context window size with the real server value 😂

- progress/status during "compacting context"
- upstream web UI (has progress bars / live status)? llama.cpp/tools/ui/src/lib/stores/chat.svelte.ts

- when we're *not* in progress (like if a slow tool command is running) we get a "stuck" looking status of the prior t/s value - can we somehow annotate that like maybe swapping the emoji from `🤔` to `👀` to make it clear this is historical?  does that update to the final values reported by the server when we finish?

- could we draw a cute little "spark line" of the live tok/s rate over time?
  - it's not perfect, but we could just fit the most recent X amount of time over a series of ▁▂▃▄▅▆▇█ scaled to the highest and lowest values

- if I `/reload` or use `/tree` to rewind time, the `turnCount` won't be correct, right?  is there any way to fix that?
