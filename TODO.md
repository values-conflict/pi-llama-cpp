- model loading progress display
- progress/status during "compacting context"
- upstream web UI (has progress bars / live status)? llama.cpp/tools/ui/src/lib/stores/chat.svelte.ts

- `/models` vs `/model` - what's up with that?  is that really worthwhile?  (I never load/unload models explicitly, only implicitly)

- can we safely detect when our prompt is "in queue" and present "Waiting" instead of the default "Working" ?  does llama.cpp report any kind of queue position information?

- when we're *not* in progress (like if a slow tool command is running) we get a "stuck" looking status of the prior t/s value - can we somehow annotate that like maybe swapping the emoji from `🤔` to `👀` to make it clear this is historical?  does that update to the final values reported by the server when we finish?
  - if we somehow *can* implement "Waiting" above, can it also show the prior final stats in a way that looks clean?

- why isn't prompt processing linear?  we currently estimate completion time but it's never even remotely accurate because prompt processing hangs after finding a cache fit

- I just got "50000.0 tok/s" on prefill status again, so something's still broken

- if I got "18833 cached / 107 new" why was the progress bar down at 9%?
  - another weird example: "0% ·  · 21193 cached / 0 new" (and it sat there for a while thinking about it, but the server logs said our `sim_best` value was actually 0.728 (~73%) -- eventually the UI switched to say "52% · 0s · 45.1 tok/s · 21193 cached / 4096 new" but the server logs say we should be at 87%
