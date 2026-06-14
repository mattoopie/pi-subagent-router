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
import { loadConfig, type RouterConfig } from "./config.ts";
import { generateSummary, extractRecentTurns } from "./summarizer.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

const SELECTOR_SYSTEM_PROMPT = `You are a task complexity classifier. Given a user prompt, classify it as exactly one of:
- complex: Hard reasoning, architecture design, debugging complex issues, multi-step refactoring, reviews
- medium: Moderate coding tasks, file modifications, feature implementation
- easy: Simple questions, formatting, explanations, single-file changes, commits/commit messages

Respond with ONLY the tier name (complex, medium, or easy). No explanation. It is mandatory to return ONE of those words ONLY.`;

type Tier = "complex" | "medium" | "easy";

// ─── State ───────────────────────────────────────────────────────────────────

let config: RouterConfig;
let turnCount = 0;
let previousModelId: string | undefined;
let needsSummary = false;

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

  if (text.includes("complex")) return "complex";
  if (text.includes("medium")) return "medium";
  if (text.includes("easy")) return "easy";

  // Default to medium if unclear
  console.warn(`[dynamic-model-router] Unexpected selector response: "${text}", defaulting to medium`);
  return "medium";
}

function extractTextFromContent(content: AgentMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text)
      .join("\n");
  }
  return "";
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // ── Reset state and load config on session start ──
  pi.on("session_start", async (_event, ctx) => {
    turnCount = 0;
    previousModelId = undefined;
    needsSummary = false;
    config = loadConfig(ctx.cwd);

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

    // 3. Call selector (standalone, outside agent loop)
    try {
      const response = await complete(
        selectorModel,
        {
          systemPrompt: SELECTOR_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: userPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        { apiKey: selectorAuth.apiKey, headers: selectorAuth.headers, maxTokens: 20 },
      );

      const tier = extractTier(response);

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
      if (modelChanged && turnCount > 1 && config.summarizeOnEverySwitch) {
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
    } catch (err) {
      console.error("[dynamic-model-router] Selector call failed:", err);
      ctx.ui.notify("Router: selector call failed, using current model", "warning");
    }

    return { action: "continue" };
  });

  // ── Context handler: summarize and filter on model switch ──
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

    const summaryText = await generateSummary(summaryModel, summaryAuth, oldMessages, ctx.signal);
    if (!summaryText) return; // Graceful degradation: pass unfiltered

    // 3. Prepend summary to the current (last) user message
    //    This avoids consecutive user-role messages that would confuse the LLM
    const filteredMessages = [...recentMessages];
    const lastUserIdx = filteredMessages.findLastIndex((m) => m.role === "user");
    if (lastUserIdx >= 0) {
      const lastUser = filteredMessages[lastUserIdx];
      const originalText = extractTextFromContent(lastUser.content);
      filteredMessages[lastUserIdx] = {
        ...lastUser,
        content: [
          {
            type: "text",
            text: `[Context Summary]\n${summaryText}\n\n---\n\n[Current Message]\n${originalText}`,
          },
        ],
      };
    }

    ctx.ui.notify("📝 Summarized context for model switch", "info");
    return { messages: filteredMessages };
  });

  // ── Cancel built-in compaction (we manage context ourselves) ──
  pi.on("session_before_compact", async () => {
    return { cancel: true };
  });

  // ── /router command ──
  pi.registerCommand("router", {
    description: "Show dynamic model router status and config",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Config: ${config.models.selector ? "loaded" : "default"}`, "info");
      ctx.ui.notify(`Selector: ${config.models.selector}`, "info");
      ctx.ui.notify(
        `Models: complex=${config.models.complex}, medium=${config.models.medium}, easy=${config.models.easy}`,
        "info",
      );
      ctx.ui.notify(`Summarization: ${config.models.summarization}`, "info");
      ctx.ui.notify(`Turn: ${turnCount}, Current model: ${ctx.model?.id ?? "none"}`, "info");
      ctx.ui.notify(`Summarize on switch: ${config.summarizeOnEverySwitch}`, "info");
      ctx.ui.notify(`Max recent turns: ${config.maxRecentTurns}`, "info");
    },
  });
}
