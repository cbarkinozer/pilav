# LM Studio Models

This directory documents the model configs used with Pi via LM Studio.

## Setup

1. Open LM Studio
2. Load a model (e.g., `lmstudio-community/gemma-4-E4B-it-MLX-4bit`)
3. Start the local API server (port 1234)
4. Pi is already configured to use it via `~/.pi/agent/models.json`

## Config

Defined in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "lm-studio": {
      "api": "openai-completions",
      "apiKey": "not-needed",
      "baseUrl": "http://localhost:1234/v1",
      "models": [...]
    }
  }
}
```

## Installed Models

| Model | File | Format | Size |
|-------|------|--------|------|
| Gemma 4 12B (QAT) | `gemma-4-12B-it-QAT-Q4_0.gguf` | GGUF Q4 | ~7 GB |
| Gemma 4 E4B (MLX 4-bit) | `model-*.safetensors` | MLX 4-bit | ~3 GB |

## Usage

```bash
pi --provider lm-studio --model lmstudio-community/gemma-4-E4B-it-MLX-4bit -p "hello"
```
