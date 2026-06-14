# pi-subagent-router

A [pi](https://github.com/earendil-works/pi) extension that dynamically routes user prompts to different models based on task complexity, with automatic context summarization on model switches -- all within a single session.

## How It Works

1. **Context-Aware Classification**: On each interactive prompt, the extension extracts the previous user message and agent response from the conversation history. These are passed to a cheap "selector" model along with the current prompt, using clear XML markers (`<PREVIOUS_USER_MESSAGE>`, `<PREVIOUS_AGENT_MESSAGE>`, `<NEW_USER_PROMPT>`) to structure the context. This allows the selector to make better routing decisions based on conversation continuity.
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
  "thinkingLevel": {
    "complex": "high",
    "medium": "medium",
    "easy": "off"
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
| `thinkingLevel.complex` | Thinking depth for complex tasks (one of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`) |
| `thinkingLevel.medium` | Thinking depth for medium tasks |
| `thinkingLevel.easy` | Thinking depth for easy tasks |
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

- `/router` -- Display current configuration and status (current model, turn count, thinking levels per tier, active tiers).

## Context-Aware Routing

The selector model receives conversation context to make better routing decisions. The context is formatted with clear XML markers:

```xml
<PREVIOUS_USER_MESSAGE>
The user's previous message in the conversation
</PREVIOUS_USER_MESSAGE>

<PREVIOUS_AGENT_MESSAGE>
The agent's response to that message (truncated to 2000 chars if needed)
</PREVIOUS_AGENT_MESSAGE>

<NEW_USER_PROMPT>
The current user message to classify
</NEW_USER_PROMPT>
```

This allows the selector to understand conversation flow. For example:
- A follow-up question to a complex topic may still need a complex model
- A simple clarification request after a detailed explanation may only need an easy model
- The full context helps avoid unnecessary model switches

## Key Behaviors

- **First turn**: Always routed to the selector's chosen model with the tier's configured thinking level. No summarization.
- **Same model twice**: All messages pass through unchanged -- no summarization.
- **Model switch**: Prior conversation is summarized and prepended to the current prompt.
- **Thinking level**: Set per-tier in config. Applied automatically after each model switch. Clamped to model capabilities by pi.
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
