Based on my analysis of the llama.cpp codebase, here are the **Server-Sent Events (SSE)** endpoints:

## SSE Endpoints

### 1. `/v1/chat/completions` - Chat completions with streaming
- **Method**: `POST`
- **Streaming**: Enabled via `stream=true` parameter
- **Description**: Main chat completion endpoint that supports real-time token streaming via SSE
- **SSE ping interval**: Configurable via `sse_ping_interval` parameter (default: 30 seconds)

### 2. `/v1/completions` - Text completions with streaming  
- **Method**: `POST`
- **Streaming**: Enabled via `stream=true` parameter
- **Description**: Legacy completion endpoint that supports real-time token streaming via SSE

### 3. `/models/sse` - Model download progress events
- **Method**: `GET` (subscribe)
- **Description**: Real-time event stream for model download progress and status updates
- **Events emitted**:
  - `model_status` - Loading, loaded, sleeping states
  - `download_progress` - Download progress percentages
  - `models_reload` - When the model list is refreshed

## SSE Configuration Options

The following parameters control SSE behavior:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `--sse-ping-interval N` | Interval between SSE comment pings while stream stays silent | 30 seconds |
| `--sse-ping-enabled` | Enable/disable ping comments | true |

## Example Usage

```bash
# Chat completions with streaming SSE
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3-8b",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true,
    "sse_ping_interval": 10
  }'

# Model download progress via SSE
curl http://localhost:8080/models/sse
```

The SSE streaming is implemented in `tools/server/server-http.cpp` and uses the `format_oai_sse()` and `format_anthropic_sse()` helper functions from `server-common.h`.
