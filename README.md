# pi-subagent-router

A [pi](https://github.com/earendil-works/pi) extension that dynamically routes user prompts to different models based on task complexity, with automatic context summarization on model switches -- all within a single session.

## How It Works

1. **Classification**: On each interactive prompt, the extension calls a cheap "selector" model to classify the task as `complex`, `medium`, or `easy`.
2. **Routing**: Based on the classification, the session model is switched to the corresponding task model defined in the config.
3. **Summarization**: When the model changes between turns, the extension summarizes the prior conversation using a dedicated summarization model and prepends that summary to the current prompt, keeping the LLM context lean.
4. **History preserved**: The full conversation history remains intact in the session file for `/tree` navigation; only the context sent to the LLM is filtered.

## Installation

```bash
# From this directory
pi install /home/marcel/projects/pi-subagent-router
```

The extension loads automatically on pi startup.

## Configuration

Create `.pi/dynamic-model-router.json` in your project directory (or set the `PI_ROUTER_CONFIG` environment variable to an absolute path). If neither is found, hardcoded defaults are used.

```json
{
  "models": {
    "selector": "opencode-go/deepseek-v4-flash",
    "complex": "opencode-go/mimo-v2.5-pro",
    "medium": "opencode-go/mimo-v2.5-pro",
    "easy": "opencode-go/deepseek-v4-flash",
    "summarization": "opencode-go/deepseek-v4-flash"
  },
  "summarizeOnEverySwitch": true,
  "maxRecentTurns": 2,
  "taskDescriptions": {
    "complex": [
      { "name": "architecture", "description": "Designing systems, planning multi-file refactors" },
      { "name": "review", "description": "Reviewing code changes or large parts of the codebase" }
    ],
    "medium": [
      { "name": "feature-implementation", "description": "Adding or modifying functionality" }
    ],
    "easy": [
      { "name": "simple-question", "description": "Quick explanations, formatting, single-file edits" }
    ]
  }
}
```

| Field | Description |
|-------|-------------|
| `models.selector` | Cheap/fast model that classifies the prompt |
| `models.complex` | Model for hard reasoning, architecture, debugging |
| `models.medium` | Model for moderate coding tasks |
| `models.easy` | Model for simple questions, formatting, explanations |
| `models.summarization` | Model for compressing prior context |
| `summarizeOnEverySwitch` | If true, summarize on every model switch; if false, only when context exceeds 100k tokens |
| `maxRecentTurns` | Number of recent user+assistant turns kept verbatim (not summarized) |
| `taskDescriptions` | Per-tier task descriptions used to build the selector prompt (see below) |

### Task Descriptions

The `taskDescriptions` field lets you customize what the selector model sees when classifying your prompts. Each tier (`complex`, `medium`, `easy`) contains a list of `{ name, description }` entries:

```json
{
  "taskDescriptions": {
    "complex": [
      { "name": "review", "description": "whenever the user wants feedback on a feature or large code change" },
      { "name": "architecture", "description": "designing systems, multi-file refactoring, complex debugging" }
    ],
    "medium": [
      { "name": "feature-implementation", "description": "adding or modifying functionality across one or a few files" }
    ],
    "easy": [
      { "name": "simple-question", "description": "quick explanations, formatting, single-file edits" }
    ]
  }
}
```

If omitted, sensible defaults are used. Each tier must have at least one entry. The names appear in the selector prompt as bullet points, helping the model understand what kind of tasks belong to each tier.

## Usage

After installation, the extension works automatically. Each prompt is classified and routed to the appropriate model. On model switches, context is summarized transparently.

Commands:

- `/router` -- Display current configuration and status (current model, turn count, active tiers).

## Key Behaviors

- **First turn**: Always routed to the selector's chosen model. No summarization.
- **Same model twice**: All messages pass through unchanged -- no summarization.
- **Model switch**: Prior conversation is summarized and prepended to the current prompt.
- **Non-interactive sources** (RPC, steer, follow-up): Pass through without routing.
- **Selector or task model unavailable**: Warning notification; the current model is retained.
- **Summarization failure**: Messages pass through unfiltered (graceful degradation).
- **Built-in compaction**: Cancelled by the extension, since context is managed internally.

## Project Structure

```
pi-subagent-router/
  extension/
    index.ts       -- Main entry point: event handlers, selector logic, /router command
    config.ts      -- Configuration loading and validation
    summarizer.ts  -- Context summarization logic
  package.json
  README.md
```

## Requirements

- pi (peer dependency, installed automatically as a dependency of pi itself)
- API keys configured in pi for all referenced models
