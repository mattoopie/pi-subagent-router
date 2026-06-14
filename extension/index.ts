/**
 * Dynamic Model Router Extension
 *
 * Intercepts each user prompt, classifies its complexity using a cheap "selector" model,
 * routes it to the appropriate task model, and manages context via summarization when
 * models switch. Everything stays in one session.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, buildSessionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadConfig, type RouterConfig, type ConfigSource, type Tier, type TaskDescriptions } from "./config.ts";
import { generateSummary, extractRecentTurns } from "./summarizer.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract text content from an AgentMessage.
 * Returns the concatenated text from all text content blocks.
 */
function extractMessageText(message: AgentMessage): string | undefined {
  const content = (message as any).content;
  if (!content) return undefined;

  // Handle string content (UserMessage can have string content)
  if (typeof content === "string") return content;

  // Handle array content
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text as string);
    return textParts.length > 0 ? textParts.join("\n") : undefined;
  }

  return undefined;
}

/**
 * Extract the previous user message and last assistant message from session context.
 * Returns formatted context with clear markers for the selector model.
 */
function extractPreviousTurnContext(
  messages: AgentMessage[],
  currentPrompt: string,
): string {
  if (messages.length === 0) return currentPrompt;

  // Walk backwards to find the most recent assistant message and user message
  // that are NOT the current prompt
  let lastAssistantText: string | undefined;
  let lastUserText: string | undefined;

  // We walk backwards through messages to find the previous turn.
  // The current user prompt hasn't been added to messages yet, so we look
  // for the most recent user+assistant pair.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = (msg as any).role;

    if (role === "assistant" && !lastAssistantText) {
      lastAssistantText = extractMessageText(msg);
    } else if (role === "user" && !lastUserText) {
      lastUserText = extractMessageText(msg);
    }

    // Stop once we have both
    if (lastAssistantText && lastUserText) break;
  }

  // If no previous context found, just return the current prompt
  if (!lastAssistantText && !lastUserText) return currentPrompt;

  // Build the enriched prompt with clear markers
  const parts: string[] = [];

  if (lastUserText) {
    parts.push(`<PREVIOUS_USER_MESSAGE>\n${lastUserText}\n</PREVIOUS_USER_MESSAGE>`);
  }

  if (lastAssistantText) {
    // Truncate long assistant messages to avoid overwhelming the selector
    const maxLen = 2000;
    const truncated = lastAssistantText.length > maxLen
      ? lastAssistantText.slice(0, maxLen) + "\n... [truncated]"
      : lastAssistantText;
    parts.push(`<PREVIOUS_AGENT_MESSAGE>\n${truncated}\n</PREVIOUS_AGENT_MESSAGE>`);
  }

  parts.push(`<NEW_USER_PROMPT>\n${currentPrompt}\n</NEW_USER_PROMPT>`);

  return parts.join("\n\n");
}

function buildSelectorPrompt(taskDescriptions: TaskDescriptions): string {
  const tiers: Tier[] = ["complex", "medium", "easy"];
  const tierBlocks = tiers.map((tier) => {
    const items = taskDescriptions[tier]
      .map((td) => `  - **${td.name}**: ${td.description}`)
      .join("\n");
    return `- **${tier}**:\n${items}`;
  });

  return `You are a task complexity classifier. Given a user prompt, classify it as exactly one of:
${tierBlocks.join("\n\n")}

The user message may contain conversation context in XML markers:
- <PREVIOUS_USER_MESSAGE>: The previous user message in the conversation
- <PREVIOUS_AGENT_MESSAGE>: The agent's response to that message
- <NEW_USER_PROMPT>: The current user message to classify

Use the conversation context to better understand what the user is asking. For example:
- If the previous turn was about a complex topic and the new prompt continues that thread, it may still be complex
- If the user is asking a follow-up clarification to a simple topic, it may be easy
- Consider the full picture, not just the isolated new prompt

Respond with ONLY the tier name (complex, medium, or easy). No explanation. It is mandatory to return ONE of those words ONLY.`;
}

// ─── State ───────────────────────────────────────────────────────────────────

const STATE_ENTRY_TYPE = "router-state";
const PERSISTENT_STATE_FILE = ".pi/router-toggle-state.json";

let config: RouterConfig;
let configSource: ConfigSource = "default";
let turnCount = 0;
let previousModelId: string | undefined;
let currentTaskModelId: string | undefined;
let needsSummary = false;
let pendingSummary: string | null = null;
let stateDirty = false;
let routerEnabled = true;
let persistentStatePath: string | undefined;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function resolveModel(ctx: ExtensionContext, modelSpec: string): Model<Api> | undefined {
  // modelSpec is "provider/model-id" format
  const slashIdx = modelSpec.indexOf("/");
  if (slashIdx < 0) {
    console.error(`[dynamic-model-router] Invalid model spec: "${modelSpec}" (expected "provider/model-id")`);
    return undefined;
  }
  const provider = modelSpec.slice(0, slashIdx);
  const modelId = modelSpec.slice(slashIdx + 1);
  return ctx.modelRegistry.find(provider, modelId);
}

function findTierForModel(config: RouterConfig, modelId: string): Tier | undefined {
  if (config.models.complex === modelId) return "complex";
  if (config.models.medium === modelId) return "medium";
  if (config.models.easy === modelId) return "easy";
  return undefined;
}

function extractTier(response: { content: Array<{ type: string; text?: string }> }): Tier {
  const text = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim()
    .toLowerCase();

  // Extract the first word to avoid false matches from sentences like "not complex, medium"
  const firstWord = text.split(/\s+/)[0] ?? "";

  if (firstWord === "complex") return "complex";
  if (firstWord === "medium") return "medium";
  if (firstWord === "easy") return "easy";

  // Fallback: substring match for cases where punctuation is attached (e.g. "complex.")
  if (firstWord.includes("complex")) return "complex";
  if (firstWord.includes("medium")) return "medium";
  if (firstWord.includes("easy")) return "easy";

  // Default to medium if unclear
  console.warn(`[dynamic-model-router] Unexpected selector response: "${text}", defaulting to medium`);
  return "medium";
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Register message renderer for expandable summary messages ──
  pi.registerMessageRenderer("router-context-summary", (message, { expanded }, theme) => {
    const details = message.details as { modelId: string; turnCount: number; summary: string } | undefined;
    const modelId = details?.modelId ?? "unknown";
    const turn = details?.turnCount ?? 0;
    const summary = details?.summary ?? "";

    let text = theme.fg("accent", theme.bold("Context summarized"));
    text += theme.fg("dim", ` for model switch to ${modelId} (turn ${turn})`);

    if (expanded && summary) {
      text += "\n\n" + theme.fg("text", summary);
    } else if (summary) {
      const preview = summary.length > 120 ? summary.slice(0, 117) + "..." : summary;
      text += "\n" + theme.fg("dim", preview);
      text += " " + theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`);
    }

    return new Text(text, 1, 1, (s) => theme.bg("customMessageBg", s));
  });

  // ── Save/load persistent toggle state ──
  function savePersistentToggleState(enabled: boolean) {
    if (!persistentStatePath) return;
    try {
      const dir = dirname(persistentStatePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(persistentStatePath, JSON.stringify({ routerEnabled: enabled }), "utf-8");
    } catch (err) {
      console.error("[dynamic-model-router] Failed to save toggle state:", err);
    }
  }

  function loadPersistentToggleState(): boolean | undefined {
    if (!persistentStatePath || !existsSync(persistentStatePath)) return undefined;
    try {
      const raw = readFileSync(persistentStatePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.routerEnabled === "boolean") {
        return parsed.routerEnabled;
      }
    } catch (err) {
      console.error("[dynamic-model-router] Failed to load toggle state:", err);
    }
    return undefined;
  }

  // ── Persist router state to session ──
  function saveState() {
    if (!stateDirty) return;
    pi.appendEntry(STATE_ENTRY_TYPE, {
      turnCount,
      previousModelId,
      currentTaskModelId,
      routerEnabled,
    });
    stateDirty = false;
  }

  // ── Reconstruct state and load config on session start ──
  pi.on("session_start", async (_event, ctx) => {
    turnCount = 0;
    previousModelId = undefined;
    currentTaskModelId = undefined;
    needsSummary = false;
    pendingSummary = null;
    stateDirty = false;
    routerEnabled = true;

    // Set persistent state path based on cwd
    persistentStatePath = join(ctx.cwd, PERSISTENT_STATE_FILE);

    // Restore router state from the latest saved entry
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as {
          turnCount?: number;
          previousModelId?: string;
          currentTaskModelId?: string;
          routerEnabled?: boolean;
        } | undefined;
        if (data) {
          turnCount = data.turnCount ?? 0;
          previousModelId = data.previousModelId;
          currentTaskModelId = data.currentTaskModelId;
          // Session state takes precedence if present
          if (data.routerEnabled !== undefined) {
            routerEnabled = data.routerEnabled;
          }
        }
        break;
      }
    }

    // Also check persistent file (for new sessions without session state)
    const persistentToggle = loadPersistentToggleState();
    if (persistentToggle !== undefined) {
      routerEnabled = persistentToggle;
    }

    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    configSource = loaded.source;

    // Show status based on restored state
    if (!routerEnabled) {
      ctx.ui.setStatus("router", ctx.ui.theme.fg("dim", "⏸ router off"));
    } else if (currentTaskModelId) {
      const tier = findTierForModel(config, currentTaskModelId);
      ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier ?? "dynamic"}`));
    } else {
      ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", "🔄 dynamic"));
    }
  });

  // ── Update status on model select ──
  pi.on("model_select", async (event, ctx) => {
    const tier = findTierForModel(config, `${event.model.provider}/${event.model.id}`);
    ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier ?? "dynamic"}`));
  });

  // ── Input handler: classify and route ──
  pi.on("input", async (event, ctx) => {
    if (!routerEnabled) return { action: "continue" };

    // Only route interactive user prompts
    if (event.source !== "interactive") return { action: "continue" };
    if (event.streamingBehavior) return { action: "continue" };

    const userPrompt = event.text;
    turnCount++;
    stateDirty = true;

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

    // 3. Call selector (standalone, outside agent loop) with animated loader
    try {
      const selectorResponse = await ctx.ui.custom<{ tier: Tier; taskModelId: string } | null>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Selecting model (${config.models.selector})...`,
          );
          loader.onAbort = () => done(null);

          const doSelect = async () => {
            const selectorTimeout = AbortSignal.timeout(10_000);
            // Race the selector call against the loader's abort signal
            const combined = AbortSignal.any([selectorTimeout, loader.signal]);

            // Extract previous turn context for better routing decisions
            const branch = ctx.sessionManager.getBranch();
            const { messages: allMessages } = buildSessionContext(branch);
            const enrichedPrompt = extractPreviousTurnContext(allMessages, userPrompt);

            const response = await complete(
              selectorModel,
              {
                systemPrompt: buildSelectorPrompt(config.taskDescriptions),
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: enrichedPrompt }],
                    timestamp: Date.now(),
                  },
                ],
              },
              { apiKey: selectorAuth.apiKey, headers: selectorAuth.headers, maxTokens: 20, signal: combined },
            );

            if (combined.aborted) return null;

            const tier = extractTier(response);

            // Resolve task model
            const taskModelId = config.models[tier];
            const taskModel = resolveModel(ctx, taskModelId);
            if (!taskModel) {
              ctx.ui.notify(`Router: task model "${taskModelId}" not found`, "warning");
              return null;
            }

            // Switch model — must succeed before updating state
            const success = await pi.setModel(taskModel);
            if (!success) {
              ctx.ui.notify(`Router: no API key for ${taskModelId}`, "warning");
              return null;
            }

            return { tier, taskModelId };
          };

          doSelect().then(done).catch(() => done(null));
          return loader;
        },
      );

      if (selectorResponse) {
        const { tier, taskModelId } = selectorResponse;

        // Track model change and decide whether to summarize
        const newModelId = taskModelId;
        const modelChanged = previousModelId !== undefined && previousModelId !== newModelId;
        if (modelChanged && turnCount > 1) {
          if (config.summarizeOnEverySwitch) {
            needsSummary = true;
          } else {
            const usage = ctx.getContextUsage();
            if (usage && usage.tokens >= 100_000) {
              needsSummary = true;
            }
          }

          // Generate summary now, before the agent loop starts.
          // The summary will be injected via before_agent_start so it appears
          // in the session immediately — before the new model's first response.
          if (needsSummary) {
            const branch = ctx.sessionManager.getBranch();
            const { messages: allMessages } = buildSessionContext(branch);
            const recentMessages = extractRecentTurns(allMessages, config.maxRecentTurns);
            const oldMessages = allMessages.slice(0, allMessages.length - recentMessages.length);

            if (oldMessages.length > 0) {
              const summaryModel = resolveModel(ctx, config.models.summarization);
              if (summaryModel) {
                const summaryAuth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
                if (summaryAuth.ok && summaryAuth.apiKey) {
                  try {
                    pendingSummary = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
                      const loader = new BorderedLoader(
                        tui,
                        theme,
                        `Summarizing context (${config.models.summarization})...`,
                      );
                      loader.onAbort = () => done(null);

                      generateSummary(summaryModel, summaryAuth, oldMessages, loader.signal)
                        .then(done)
                        .catch(() => done(null));

                      return loader;
                    });
                  } catch (err) {
                    console.error("[dynamic-model-router] Summarization failed:", err);
                  }
                }
              }
            }
          }
        }
        previousModelId = newModelId;
        currentTaskModelId = taskModelId;

        ctx.ui.notify(`⚡ Model: ${taskModelId.split("/").pop()} (${tier})`, "info");
        ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier}`));
      } else {
        ctx.ui.notify("Router: selection cancelled or failed", "warning");
      }
    } catch (err) {
      console.error("[dynamic-model-router] Selector call failed:", err);
      ctx.ui.notify("Router: selector call failed, using current model", "warning");
    }

    saveState();
    return { action: "continue" };
  });

  // ── Inject summary before agent loop starts ──
  //    before_agent_start fires BEFORE the agent loop. Returning a message here
  //    stores it in the session immediately — visible before the new model responds.
  pi.on("before_agent_start", async () => {
    if (!pendingSummary) return;

    const summaryText = pendingSummary;
    pendingSummary = null;

    return {
      message: {
        customType: "router-context-summary",
        content: `[Context Summary]\n${summaryText}`,
        display: true,
        details: {
          modelId: currentTaskModelId,
          turnCount,
          summary: summaryText,
        },
      },
    };
  });

  // ── Context handler: filter old messages on model switch ──
  //    The summary is already in the session (injected by before_agent_start).
  //    We just need to drop old messages so the LLM only sees the summary + recent turns.
  pi.on("context", async (event) => {
    if (!needsSummary || turnCount <= 1) return;
    needsSummary = false;

    const allMessages = event.messages;
    if (allMessages.length === 0) return;

    // Keep only the last N turns. The summary entry (role: "custom") sits
    // between old and recent messages, so it naturally lands in the recent set.
    const recentMessages = extractRecentTurns(allMessages, config.maxRecentTurns);

    if (recentMessages.length >= allMessages.length) return; // Nothing to trim

    return { messages: recentMessages };
  });

  // ── Persist state on session exit ──
  pi.on("session_shutdown", async () => {
    saveState();
  });

  // ── Cancel built-in compaction (we manage context ourselves) ──
  pi.on("session_before_compact", async () => {
    return { cancel: true };
  });

  // ── /router command ──
  pi.registerCommand("router", {
    description: "Show dynamic model router status and config",
    handler: async (_args, ctx) => {
      if (!routerEnabled) {
        ctx.ui.notify("Router is OFF (use /router-toggle to enable)", "info");
        return;
      }

      const lines = [
        "Router is ON",
        `Config source: ${configSource}`,
        `Selector: ${config.models.selector}`,
        `Models: complex=${config.models.complex}, medium=${config.models.medium}, easy=${config.models.easy}`,
        `Summarization: ${config.models.summarization}`,
        `Turn: ${turnCount}, Current model: ${ctx.model?.id ?? "none"}`,
        `Summarize on switch: ${config.summarizeOnEverySwitch}`,
        `Max recent turns: ${config.maxRecentTurns}`,
        "Task descriptions:",
      ];
      for (const tier of ["complex", "medium", "easy"] as const) {
        const items = config.taskDescriptions[tier].map((td) => td.name).join(", ");
        lines.push(`  ${tier}: ${items}`);
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── /router-toggle command ──
  pi.registerCommand("router-toggle", {
    description: "Toggle the dynamic model router on/off",
    handler: async (_args, ctx) => {
      routerEnabled = !routerEnabled;
      stateDirty = true;
      saveState();
      savePersistentToggleState(routerEnabled);

      if (routerEnabled) {
        ctx.ui.notify("🔄 Router enabled", "info");
        ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", "🔄 dynamic"));
      } else {
        ctx.ui.notify("⏸ Router disabled", "info");
        ctx.ui.setStatus("router", ctx.ui.theme.fg("dim", "⏸ router off"));
      }
    },
  });
}
