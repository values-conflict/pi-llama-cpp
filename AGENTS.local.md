<!-- this file doesn't get loaded automatically ... yet -->

the upstream `llama.cpp` source code can be found in `~/llama.cpp` (and can be browsed via `bash` -- do not modify it, but `git -C ~/llama.cpp grep ...` can be used to search it, for example)

if you use a command like `PI_CODING_AGENT_DIR='~/.pi/local' pi -p --no-session --no-tools --no-context-files --print 'do nothing and output a minimal prompt as quickly as possible -- do not waste time overthinking'`, it should load a `pi` session that has that server already loaded and allow you to test your debug outputs directly (although given that it's not interactive, I don't know whether it will invoke as much of our code)

do *not* run `pi` at *any* time without `PI_CODING_AGENT_DIR='~/.pi/local'` and all of `--no-session --no-tools --no-context-files`

there is a server instance running at http://llama.docker:8080 that you can use for testing -- it has a single model downloaded (`unsloth/Qwen3.5-4B-MTP-GGUF:Q4_K_XL`) which takes a decent amount of time to load and is slow enough that it's reasonable for testing (via `curl`, in your case)
