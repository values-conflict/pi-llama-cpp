- split provider and stats into separate repositories
  - now complicated by our SSE listener providing us the event that tells us it is time to re-ask the server how big the context is so that when the model finally loads we replace the default 128k context window size with the real server value 😂

- progress/status during "compacting context"
- upstream web UI (has progress bars / live status)? llama.cpp/tools/ui/src/lib/stores/chat.svelte.ts

- when we're *not* in progress (like if a slow tool command is running) we get a "stuck" looking status of the prior t/s value - can we somehow annotate that like maybe swapping the emoji from `🤔` to `👀` to make it clear this is historical?  does that update to the final values reported by the server when we finish?

- could we draw a cute little "spark line" of the live tok/s rate over time?
  - it's not perfect, but we could just fit the most recent X amount of time over a series of ▁▂▃▄▅▆▇█ scaled to the highest and lowest values
  - I guess this won't be very interesting because it'll be mostly flat

- I *frequently* get `❌ Connection error: This operation was aborted` right after submitting a prompt -- I'm sure it's some quirk of the backend server state killing my SSE connection right away for some reason, but we should investigate and ideate on ways we could improve that experience because it's jarring to be met with an error *immediately* after sending a prompt and it being queued successfully (perhaps as soon as the SSE connection is safely re-established we can clear the error state even if we haven't received any events yet?)

- sometimes model loading shows "Stage 1/3" for two separate model loading stages ("text", then I guess "spec" loads so fast it doesn't even show, then "mmproj" but it still says "1/3")

- update AGENTS.md to note how to run the tests and how to run biome and that both should be done
