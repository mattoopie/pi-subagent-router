# Dynamic Model Router Extension

## Overview

A pi extension that intercepts each user prompt, classifies its complexity using a cheap "selector" model, routes it to the appropriate task model, and manages context via summarization when models switch. Everything stays in one session.

## User Experience

1. User starts pi normally. The extension loads automatically.
2. User sends a prompt. Instead of picking a model manually, the extension:
   - Calls the **selector model** with a minimal prompt + user query → returns a complexity tier
   - Switches the active model to the corresponding task model
   - Prints: `⚡ Model selected: claude-sonnet-4-5 (complex)`
3. On subsequent prompts where the model changes:
   - Calls the **summarization model** to compress all prior conversation into a summary
   - Prepends the summary to the current prompt so the LLM sees minimal context
   - Prints: `📝 Summarized context for model switch`
   - Then selects and switches to the new model
4. User sees everything in one session, can scroll back through full history.

## Architecture

### Extension Type

TypeScript pi package, installed from this repository as a local git package.

```
pi-subagent-router/
├── PLAN.md
├── README.md
├── package.json
├── package-lock.json
├── node_modules/
│   └── @earendil-works/pi-coding-agent/   # peer dep, installed locally
└── extension/
    ├── index.ts                            # main entry point
    ├── config.ts                           # config loading & types
    └── summarizer.ts                       # summarization logic
```

Install with: `pi install /home/marcel/projects/pi-subagent-router`

### Configuration

The extension looks for a JSON config file in this order:

1. `PI_ROUTER_CONFIG` environment variable (absolute path)
2. `.pi/dynamic-model-router.json` in the current working directory (project-local)
3. Hardcoded defaults

Users create `.pi/dynamic-model-router.json` in their project to customize. Example:

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
  "maxRecentTurns": 2
}
```

- `models.selector` — Cheap/fast model that classifies complexity
- `models.complex` — For hard reasoning, architecture, debugging
- `models.medium` — For moderate tasks
- `models.easy` — For simple questions, formatting, explanations
- `models.summarization` — Cheap model for context summarization
- `summarizeOnEverySwitch` — If `true`, summarize context on every model switch (default). If `false`, only summarize when context exceeds a token threshold.
- `maxRecentTurns` — Number of recent turns to keep verbatim (not summarized) when summarizing. Default: 2.

### Event Flow

```
User types prompt
  │
  ├─► input handler:
  │     1. Skip if source is not "interactive" or is a streaming follow-up
  │     2. Call selector model via `complete()` (bypasses agent loop entirely)
  │     3. Parse result → complexity tier ("complex" | "medium" | "easy")
  │     4. Look up task model from config
  │     5. Track whether model changed from previous turn
  │     6. Call `pi.setModel(taskModel)`
  │     7. Notify user of selected model
  │     8. Return `{ action: "continue" }` → agent loop proceeds
  │
  ├─► context handler:
  │     1. If model changed since last turn AND this isn't turn 1:
  │        a. Generate summary of old messages using summarization model
  │        b. Prepend summary to the current user message
  │        c. Return only: [summary+currentPrompt, ...recentAssistantTurns]
  │        d. Notify user that context was summarized
  │     2. Otherwise: return (no modification, pass all messages)
  │
  ├─► session_before_compact handler:
  │     1. Cancel built-in compaction (we manage context ourselves)
  │     return { cancel: true }
  │
  └─► Agent proceeds with selected model and filtered context
```

### Key Implementation Details

#### 1. Model Resolution

Each model string in config is `"provider/model-id"` format. The extension resolves these using `ctx.modelRegistry.find(provider, id)`. Missing models produce a warning notification and fall back to the current model.

#### 2. Selector Call

Uses `complete()` from `@earendil-works/pi-ai` — a standalone LLM call that bypasses the agent loop entirely. This keeps the selector call isolated from the main session context.

```typescript
const response = await complete(
  selectorModel,
  {
    systemPrompt: SELECTOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
  },
  { apiKey: auth.apiKey, headers: auth.headers, maxTokens: 20 },
);
```

Note: `ctx.signal` is not available in the `input` handler (no agent turn is active yet), so the selector call cannot be aborted by the user. It should be fast enough that this isn't an issue.

The selector system prompt:
```
You are a task complexity classifier. Given a user prompt, classify it as exactly one of:
- complex: Hard reasoning, architecture design, debugging complex issues, multi-step refactoring, reviews
- medium: Moderate coding tasks, file modifications, feature implementation
- easy: Simple questions, formatting, explanations, single-file changes, commits/commit messages

Respond with ONLY the tier name (complex, medium, or easy). No explanation. It is mandatory to return ONE of those words ONLY.
```

#### 3. Summarization Call

Also uses `complete()` directly. The summarization model receives the serialized conversation (via `serializeConversation(convertToLlm(messages))`) and returns a structured summary.

The summary includes:
- Goals and objectives
- Key decisions made
- Files read/modified (extracted from tool calls in the serialized output)
- Current state of work
- Recent tool calls and their results (for continuity)

#### 4. Context Filtering

The `context` handler (which fires before each LLM call) filters messages:

```
Turn 1 (no model change): pass all messages as-is

Turn N (model changed):
  [summary prepended to current user prompt]  ← generated summary + current message
  [recent assistant turn 1]                    ← verbatim recent turns
  [recent assistant turn 2]
  ...
```

The summary is **prepended to the current user message** rather than injected as a separate message. This avoids consecutive `user`-role messages that would confuse the LLM. The format is:

```
[Context Summary]
{summary text}

---

[Current Message]
{original user prompt}
```

Since the `context` handler modifies only the message array sent to the LLM (not the persisted session), the session tree retains the full original history for `/tree` navigation.

#### 5. State Management

Module-level state:
```typescript
let config: RouterConfig;
let turnCount: number = 0;
let previousModelId: string | undefined;
let needsSummary: boolean = false;
```

Reset on `session_start`:
```typescript
pi.on("session_start", async (_event, ctx) => {
  turnCount = 0;
  previousModelId = undefined;
  needsSummary = false;
  config = loadConfig(ctx.cwd);
});
```

#### 6. Built-in Compaction Override

Disable pi's built-in compaction since we manage context ourselves:

```typescript
pi.on("session_before_compact", async () => {
  return { cancel: true };
});
```

This is safe because:
- Our context filtering keeps the LLM context small
- The full history is preserved in the session file for `/tree` navigation
- If the user manually runs `/compact`, it is cancelled (our system handles context)

#### 7. Status Display

Show the current model and router status in the footer:

```typescript
pi.on("session_start", async (_event, ctx) => {
  ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", "🔄 dynamic"));
});

pi.on("model_select", async (event, ctx) => {
  const tier = findTierForModel(config, event.model.id);
  ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier ?? "dynamic"}`));
});
```

#### 8. `/router` Command

Register a `/router` command to show current config and status:

```typescript
pi.registerCommand("router", {
  description: "Show dynamic model router status and config",
  handler: async (_args, ctx) => {
    ctx.ui.notify(`Config: ${configPath}`, "info");
    ctx.ui.notify(`Selector: ${config.models.selector}`, "info");
    ctx.ui.notify(`Models: complex=${config.models.complex}, medium=${config.models.medium}, easy=${config.models.easy}`, "info");
    ctx.ui.notify(`Summarization: ${config.models.summarization}`, "info");
    ctx.ui.notify(`Turn: ${turnCount}, Current model: ${ctx.model?.id}`, "info");
  },
});
```

## Files to Create

All files are inside this repository. Nothing is written to `~/.pi/agent/`.

### 1. `package.json`

```json
{
  "name": "pi-subagent-router",
  "version": "0.0.1",
  "description": "Pi extension that dynamically routes prompts to different models based on complexity.",
  "keywords": ["pi-package", "pi-extension", "pi-coding-agent"],
  "license": "MIT",
  "type": "module",
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "pi": {
    "extensions": ["./extension/index.ts"]
  }
}
```

Run `npm install` after creating to install the peer dependency locally.

### 2. `extension/config.ts`

Config types and loading:

```typescript
export interface RouterModels {
  selector: string;
  complex: string;
  medium: string;
  easy: string;
  summarization: string;
}

export interface RouterConfig {
  models: RouterModels;
  summarizeOnEverySwitch: boolean;
  maxRecentTurns: number;
}

export const DEFAULT_CONFIG: RouterConfig = { ... };

export function loadConfig(cwd: string): RouterConfig { ... }
```

### 3. `extension/summarizer.ts`

Summarization logic (calls summarization model via `complete()`):

```typescript
export async function generateSummary(ctx, config, oldMessages): Promise<string | null> { ... }
export function extractRecentTurns(messages, n): Message[] { ... }
```

### 4. `extension/index.ts`

Main entry point — event handlers, selector logic, `/router` command. Structure:

```
Imports
├── complete from @earendil-works/pi-ai
├── convertToLlm, serializeConversation from @earendil-works/pi-coding-agent
├── readFileSync, existsSync from node:fs
├── join from node:path
Type definitions
├── RouterConfig { models: { selector, complex, medium, easy, summarization }, summarizeOnEverySwitch, maxRecentTurns }

Constants
├── SELECTOR_SYSTEM_PROMPT
├── SUMMARY_SYSTEM_PROMPT
├── DEFAULT_CONFIG

Config loading (from config.ts)
├── loadConfig(cwd: string): RouterConfig
│   ├── Check PI_ROUTER_CONFIG env var
│   ├── Check .pi/dynamic-model-router.json (project-local)
│   └── Fall back to DEFAULT_CONFIG

State (module-level)
├── config: RouterConfig
├── turnCount: number
├── previousModelId: string | undefined
├── needsSummary: boolean

Helpers
├── resolveModel(ctx, "provider/id"): Model | undefined
├── findTierForModel(config, modelId): "complex" | "medium" | "easy" | undefined
├── extractTier(response): "complex" | "medium" | "easy"
├── extractText(response): string
├── extractRecentTurns(messages, n): Message[]
│   └── Walk backwards from end, collect N complete turns (user+assistant pairs)

Event handlers
├── session_start: load config, reset state, set footer status
├── input: call selector, switch model, notify, return continue
├── context: if model changed, summarize and filter messages
├── session_before_compact: cancel built-in compaction
├── model_select: update footer status

Commands
├── /router: show status and config
```

## Detailed Code Flow

### `input` handler (the core routing logic)

```typescript
pi.on("input", async (event, ctx) => {
  // Only route interactive user prompts (skip RPC, extension, steer, followUp)
  if (event.source !== "interactive") return { action: "continue" };
  if (event.streamingBehavior) return { action: "continue" };

  const userPrompt = event.text;
  turnCount++;

  // 1. Resolve selector model
  const selectorModel = resolveModel(ctx, config.models.selector);
  if (!selectorModel) {
    ctx.ui.notify("Router: selector model not found, using current model", "warning");
    return { action: "continue" };
  }

  // 2. Get auth for selector
  const selectorAuth = await ctx.modelRegistry.getApiKeyAndHeaders(selectorModel);
  if (!selectorAuth.ok || !selectorAuth.apiKey) {
    ctx.ui.notify("Router: no API key for selector model", "warning");
    return { action: "continue" };
  }

  // 3. Call selector (standalone, outside agent loop)
  const response = await complete(
    selectorModel,
    {
      systemPrompt: SELECTOR_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
    },
    { apiKey: selectorAuth.apiKey, headers: selectorAuth.headers, maxTokens: 20 },
  );

  const tier = extractTier(response); // "complex" | "medium" | "easy"

  // 4. Resolve task model
  const taskModelId = config.models[tier];
  const taskModel = resolveModel(ctx, taskModelId);
  if (!taskModel) {
    ctx.ui.notify(`Router: task model "${taskModelId}" not found`, "warning");
    return { action: "continue" };
  }

  // 5. Track model change
  const newModelId = `${taskModel.provider}/${taskModel.id}`;
  const modelChanged = previousModelId !== undefined && previousModelId !== newModelId;
  if (modelChanged && turnCount > 1) {
    needsSummary = true;
  }
  previousModelId = newModelId;

  // 6. Switch model
  const success = await pi.setModel(taskModel);
  if (!success) {
    ctx.ui.notify(`Router: no API key for ${taskModelId}`, "warning");
    return { action: "continue" };
  }
  ctx.ui.notify(`⚡ Model: ${taskModel.id} (${tier})`, "info");

  return { action: "continue" };
});
```

### `context` handler (summarization and filtering)

```typescript
pi.on("context", async (event, ctx) => {
  if (!needsSummary || turnCount <= 1) return;
  needsSummary = false;

  const allMessages = event.messages;
  if (allMessages.length === 0) return;

  // 1. Find recent turns (last N complete user+assistant pairs)
  const recentMessages = extractRecentTurns(allMessages, config.maxRecentTurns);
  const oldMessages = allMessages.slice(0, allMessages.length - recentMessages.length);

  if (oldMessages.length === 0) return; // Nothing to summarize

  // 2. Generate summary using summarization model
  const summaryModel = resolveModel(ctx, config.models.summarization);
  if (!summaryModel) return;

  const summaryAuth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
  if (!summaryAuth.ok || !summaryAuth.apiKey) return;

  const conversationText = serializeConversation(convertToLlm(oldMessages));
  const summaryResponse = await complete(
    summaryModel,
    {
      systemPrompt: SUMMARY_SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: conversationText }], timestamp: Date.now() }],
    },
    { apiKey: summaryAuth.apiKey, headers: summaryAuth.headers, maxTokens: 2000, signal: ctx.signal },
  );

  const summaryText = extractText(summaryResponse);
  if (!summaryText) return; // Graceful degradation: pass unfiltered

  // 3. Prepend summary to the current (last) user message
  //    This avoids consecutive user-role messages that would confuse the LLM
  const filteredMessages = [...recentMessages];
  const lastUserIdx = filteredMessages.findLastIndex(m => m.role === "user");
  if (lastUserIdx >= 0) {
    const lastUser = filteredMessages[lastUserIdx];
    const originalText = extractTextFromContent(lastUser.content);
    filteredMessages[lastUserIdx] = {
      ...lastUser,
      content: [{ type: "text", text: `[Context Summary]\n${summaryText}\n\n---\n\n[Current Message]\n${originalText}` }],
    };
  }

  ctx.ui.notify("📝 Summarized context for model switch", "info");
  return { messages: filteredMessages };
});
```

### `session_before_compact` handler

```typescript
pi.on("session_before_compact", async () => {
  return { cancel: true };
});
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| First turn ever | No summarization, just route to selector-chosen model |
| Same model selected twice in a row | No summarization, pass all messages as-is |
| Selector model not in registry | Warning notification, keep current model |
| Task model not in registry | Warning notification, keep current model |
| No API key for selector | Warning notification, keep current model |
| No API key for task model | Warning notification, keep current model |
| Summarization model call fails | Pass all messages unfiltered (graceful degradation) |
| Config file missing | Use hardcoded defaults |
| Config file malformed JSON | Log error to stderr, use hardcoded defaults |
| `event.source !== "interactive"` | Skip routing (pass through unchanged) |
| Steering / follow-up messages | Skip routing (pass through unchanged) |
| User manually runs `/compact` | Cancelled by our `session_before_compact` handler |
| Context is tiny (2 messages) | Still summarize if model switched (per user requirement) |

## Dependencies

The extension uses only pi's built-in imports — no npm packages needed:

| Import | Source | Purpose |
|--------|--------|---------|
| `complete` | `@earendil-works/pi-ai` | Standalone LLM calls for selector and summarizer |
| `convertToLlm` | `@earendil-works/pi-coding-agent` | Convert session messages to LLM format |
| `serializeConversation` | `@earendil-works/pi-coding-agent` | Serialize messages to readable text |
| `readFileSync`, `existsSync` | `node:fs` | Config file loading |
| `join` | `node:path` | Path construction |

## Installation & Testing

### Install

```bash
pi install /home/marcel/projects/pi-subagent-router
```

This registers the extension globally. No files are copied to `~/.pi/agent/`.

### Test

1. **Manual test**: Start pi, verify:
   - First prompt routes correctly (check notification in TUI)
   - Model switch triggers summarization notification
   - Context is actually filtered (token count in footer should drop)
   - `/router` command shows correct status
   - Full history is visible in `/tree`
   - Same model twice = no summarization

2. **Config test**: Create `.pi/dynamic-model-router.json` in a project, edit models, run `/reload`, verify changes take effect

3. **Edge case test**:
   - Set selector to same model as a task tier
   - Set an invalid model ID in config
   - Remove API key for a model
   - Send a prompt via `pi -p` (print mode) — should skip routing

## Future Enhancements (out of scope)

- Interactive model configuration via `/router-config` command with TUI
- Per-project model presets (already possible via `.pi/dynamic-model-router.json`)
- Token-based routing (route based on estimated output length)
- Streaming model selection (show selector thinking)
- Custom tier definitions beyond 3 levels
- Learning from user overrides (if user manually switches model, adjust routing)
