- why do I have to do a full `/reload` for pi to pick up context size changes from the model default vs the loaded model?

- split provider and stats into separate repositories

- progress/status during "compacting context"
- upstream web UI (has progress bars / live status)? llama.cpp/tools/ui/src/lib/stores/chat.svelte.ts

- when we're *not* in progress (like if a slow tool command is running) we get a "stuck" looking status of the prior t/s value - can we somehow annotate that like maybe swapping the emoji from `🤔` to `👀` to make it clear this is historical?  does that update to the final values reported by the server when we finish?

- why isn't prompt processing linear?  we currently estimate completion time but it's never even remotely accurate because prompt processing hangs after finding a cache fit

- I just got "50000.0 tok/s" on prefill status again, so something's still broken

- if I got "18833 cached / 107 new" why was the progress bar down at 9%?
  - another weird example: "0% ·  · 21193 cached / 0 new" (and it sat there for a while thinking about it, but the server logs said our `sim_best` value was actually 0.728 (~73%) -- eventually the UI switched to say "52% · 0s · 45.1 tok/s · 21193 cached / 4096 new" but the server logs say we should be at 87%

- the Prefilling percentages are often different from what I see in the server logs - the server will say `0.93` but the progress bar will say `90%` (or sometimes even further apart) - is that expected?
  - similarly, the estimated time to completion of prefilling will often say `0ms` for several minutes, or say `6m` for more like 10 -- are those *our* estimates, or the server's?

- could we draw a cute little "spark line" of the live tok/s rate over time?
  - it's not perfect, but we could just fit the most recent X amount of time over a series of ▁▂▃▄▅▆▇█ scaled to the highest and lowest values

- if I `/reload` or use `/tree` to rewind time, the `turnCount` won't be correct, right?  is there any way to fix that?
