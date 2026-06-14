import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { RouterConfig } from "./config.ts";
import type { RouterState } from "./router-state.ts";
import { resolveModel } from "./utils.ts";
import { generateSummary, extractRecentTurns } from "./summarizer.ts";

/**
 * Decide whether summarization is needed based on model change,
 * turn count, config flags, and current context size.
 */
export function shouldSummarize(
  state: RouterState,
  config: RouterConfig,
  ctx: ExtensionContext,
  newModelId: string,
): boolean {
  if (state.turnCount <= 1) return false;
  const modelChanged = state.previousModelId !== undefined && state.previousModelId !== newModelId;
  if (!modelChanged) return false;
  if (config.summarizeOnEverySwitch) return true;
  const usage = ctx.getContextUsage();
  return !!(usage && usage.tokens >= 100_000);
}

/**
 * Generate a summary of old context messages before a model switch.
 * Shows a loader UI while summarization runs.
 * Returns the summary text, or null on failure.
 */
export async function runSummarization(
  ctx: ExtensionContext,
  config: RouterConfig,
): Promise<string | null> {
  const branch = ctx.sessionManager.getBranch();
  const { messages: allMessages } = buildSessionContext(branch);
  const recentMessages = extractRecentTurns(allMessages, config.maxRecentTurns);
  const oldMessages = allMessages.slice(0, allMessages.length - recentMessages.length);

  if (oldMessages.length === 0) return null;

  const summaryModel = resolveModel(ctx, config.models.summarization);
  if (!summaryModel) return null;

  const summaryAuth = await ctx.modelRegistry.getApiKeyAndHeaders(summaryModel);
  if (!summaryAuth.ok || !summaryAuth.apiKey) return null;

  try {
    return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
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
    return null;
  }
}

/**
 * Build the `before_agent_start` event payload that injects a summary
 * message into the session. Consumes `state.pendingSummary`.
 */
export function buildBeforeAgentStartPayload(
  state: RouterState,
): { message: { customType: string; content: string; display: boolean; details: Record<string, unknown> } } | undefined {
  if (!state.pendingSummary) return undefined;

  const summaryText = state.pendingSummary;
  state.pendingSummary = null;

  return {
    message: {
      customType: "router-context-summary",
      content: `[Context Summary]\n${summaryText}`,
      display: true,
      details: {
        modelId: state.currentTaskModelId,
        turnCount: state.turnCount,
        summary: summaryText,
      },
    },
  };
}

/**
 * Filter context messages to keep only recent turns after a summary has been injected.
 * Consumes `state.needsSummary`.
 */
export function filterContextMessages(
  messages: AgentMessage[],
  config: RouterConfig,
  state: RouterState,
): { messages: AgentMessage[] } | undefined {
  if (!state.needsSummary || state.turnCount <= 1) return undefined;
  state.needsSummary = false;

  if (messages.length === 0) return undefined;

  const recentMessages = extractRecentTurns(messages, config.maxRecentTurns);
  if (recentMessages.length >= messages.length) return undefined;

  return { messages: recentMessages };
}
