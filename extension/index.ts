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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

Respond with ONLY the tier name (complex, medium, or easy). No explanation. It is mandatory to return ONE of those words ONLY.`;
}

// ─── State ───────────────────────────────────────────────────────────────────

let config: RouterConfig;
let configSource: ConfigSource = "default";
let turnCount = 0;
let previousModelId: string | undefined;
let currentTaskModelId: string | undefined;
let needsSummary = false;
let pendingSummary: string | null = null;

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

  // ── Reset state and load config on session start ──
  pi.on("session_start", async (_event, ctx) => {
    turnCount = 0;
    previousModelId = undefined;
    currentTaskModelId = undefined;
    needsSummary = false;
    pendingSummary = null;
    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    configSource = loaded.source;

    ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", "🔄 dynamic"));
  });

  // ── Update status on model select ──
  pi.on("model_select", async (event, ctx) => {
    const tier = findTierForModel(config, `${event.model.provider}/${event.model.id}`);
    ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier ?? "dynamic"}`));
  });

  // ── Input handler: classify and route ──
  pi.on("input", async (event, ctx) => {
    // Only route interactive user prompts
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

            const response = await complete(
              selectorModel,
              {
                systemPrompt: buildSelectorPrompt(config.taskDescriptions),
                messages: [
                  {
                    role: "user",
                    content: [{ type: "text", text: userPrompt }],
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

  // ── Cancel built-in compaction (we manage context ourselves) ──
  pi.on("session_before_compact", async () => {
    return { cancel: true };
  });

  // ── /router command ──
  pi.registerCommand("router", {
    description: "Show dynamic model router status and config",
    handler: async (_args, ctx) => {
      const lines = [
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
}
