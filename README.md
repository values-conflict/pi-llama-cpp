# pi-llama-cpp

A [Pi Coding Agent](https://pi.dev/) extension that integrates with running [llama.cpp servers](https://github.com/ggml-org/llama.cpp) using Pi's upstream dynamic provider apparatus, enhanced with inference status tracking and thinking budget support.

## Features

- **Dynamic model catalog** — all available models appear in `/model` automatically (not just loaded ones), leveraging llama.cpp's auto-loading behavior
- **Inference status display** — prefill progress bar and generation speed shown in Pi's working message during conversations
- **Thinking budget support** — configurable token budgets for model reasoning/thinking, mapped to Pi's thinking levels

### Inference Status Display

During a conversation with a llama.cpp model, the extension intercepts server responses to show real-time inference progress.

**Prefill phase** — while the model processes your prompt:
```
Prefilling... ████████████░░░░░░░░ 65% · 12s · 48.3 tok/s
```

**Generation phase** — after prefill completes:
```
🤔 28.5 tok/s · 142 tokens in 5.0s
```

## Installation

```bash
pi install https://github.com/values-conflict/pi-llama-cpp.git
```

## Configuration

Configure the llama.cpp server URL via Pi's built-in provider auth:

```text
/login llama.cpp
```

Enter your router URL (default: `http://127.0.0.1:8080`) and optional API key.

Or use environment variables:

```bash
export LLAMA_BASE_URL=http://127.0.0.1:8080
export LLAMA_API_KEY=optional-secret
pi
```

## Usage

### Prerequisites

Start `llama-server` in router mode (without `--model`):

```bash
llama-server \
  --models-dir ~/models \
  --jinja \
  -ngl 999 \
  -c 32768
```

### Model Selection

All available models appear in `/model` automatically. When you select an unloaded model, llama.cpp auto-loads it before serving the request — no manual loading step needed.

For advanced management (unload specific models, download from Hugging Face), use Pi's built-in `/llama` command if your version supports it.

### Thinking Budgets

The extension injects thinking budgets based on Pi's selected thinking level:

| Level     | Tokens | Description                  |
| --------- | ------ | ---------------------------- |
| `off`     | 0      | Thinking disabled            |
| `minimal` | 1,024  | Short reasoning steps        |
| `low`     | 2,048  | Light reasoning              |
| `medium`  | 8,192  | Balanced reasoning (default) |
| `high`    | 16,384 | Extended reasoning           |
| `xhigh`   | 32,768 | Deep reasoning               |
| `max`     | -1     | Unlimited reasoning          |

Override defaults in `.pi/settings.json`:

```json
{
  "thinkingBudgets": {
    "minimal": 256,
    "low": 1024,
    "medium": 2048,
    "high": 4096,
    "xhigh": 8192
  }
}
```

## Dependencies

| Peer dependency                   | Purpose             |
| --------------------------------- | ------------------- |
| `@earendil-works/pi-ai`           | Pi AI SDK           |
| `@earendil-works/pi-coding-agent` | Pi Coding Agent SDK |
