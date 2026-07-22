# pi-llama-cpp Extension

Fork of Pi's built-in llama.cpp extension (`../pi/packages/coding-agent/src/extensions/llama/`).

## Upstream Sync

See [`src/upstream/README.md`](src/upstream/README.md) for diff commands and sync procedure.

## Deviations from Upstream

All deviations are marked with `// DEVIATION FROM UPSTREAM:` comments in the source. Find them:
```bash
grep -rn 'DEVIATION FROM UPSTREAM' src/client.ts src/provider.ts
```
The comment on each deviation explains why it exists.

## Non-forked Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry point, event handlers, catalog refresh logic |
| `inference-status.ts` | Fetch interceptor for live prefill/gen timing display in Pi's UI |
| `resolver.ts` | Thinking budget resolution from Pi settings |
