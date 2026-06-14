import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { RouterConfig, Tier, TaskDescriptions } from "./config.ts";
import { resolveModel } from "./utils.ts";

// ─── Message text extraction ─────────────────────────────────────────────────

function extractMessageText(message: AgentMessage): string | undefined {
  const content = (message as any).content;
  if (!content) return undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text as string);
    return textParts.length > 0 ? textParts.join("\n") : undefined;
  }
  return undefined;
}

/**
 * Build an enriched prompt that includes the previous user/assistant turn
 * as XML-marked context, so the selector model can make better routing decisions.
 */
function extractPreviousTurnContext(
  messages: AgentMessage[],
  currentPrompt: string,
): string {
  if (messages.length === 0) return currentPrompt;

  let lastAssistantText: string | undefined;
  let lastUserText: string | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = (msg as any).role;

    if (role === "assistant" && !lastAssistantText) {
      lastAssistantText = extractMessageText(msg);
    } else if (role === "user" && !lastUserText) {
      lastUserText = extractMessageText(msg);
    }

    if (lastAssistantText && lastUserText) break;
  }

  if (!lastAssistantText && !lastUserText) return currentPrompt;

  const parts: string[] = [];

  if (lastUserText) {
    parts.push(`<PREVIOUS_USER_MESSAGE>\n${lastUserText}\n</PREVIOUS_USER_MESSAGE>`);
  }

  if (lastAssistantText) {
    const maxLen = 2000;
    const truncated = lastAssistantText.length > maxLen
      ? lastAssistantText.slice(0, maxLen) + "\n... [truncated]"
      : lastAssistantText;
    parts.push(`<PREVIOUS_AGENT_MESSAGE>\n${truncated}\n</PREVIOUS_AGENT_MESSAGE>`);
  }

  parts.push(`<NEW_USER_PROMPT>\n${currentPrompt}\n</NEW_USER_PROMPT>`);

  return parts.join("\n\n");
}

// ─── Selector prompt & response parsing ──────────────────────────────────────

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

  console.warn(`[dynamic-model-router] Unexpected selector response: "${text}", defaulting to medium`);
  return "medium";
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Run the full selector pipeline:
 * 1. Resolve and authenticate the selector model
 * 2. Build an enriched prompt with conversation context
 * 3. Call the selector model to classify complexity
 * 4. Resolve and switch to the appropriate task model
 *
 * Returns `{ tier, taskModelId, thinkingLevel }` on success, `null` on any failure.
 * Shows loader UI and user-facing notifications for errors.
 */
export async function runSelector(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: RouterConfig,
  userPrompt: string,
): Promise<{ tier: Tier; taskModelId: string; thinkingLevel: ThinkingLevel } | null> {
  const selectorModel = resolveModel(ctx, config.models.selector);
  if (!selectorModel) {
    ctx.ui.notify("Router: selector model not found, using current model", "warning");
    return null;
  }

  const selectorAuth = await ctx.modelRegistry.getApiKeyAndHeaders(selectorModel);
  if (!selectorAuth.ok || !selectorAuth.apiKey) {
    ctx.ui.notify("Router: no API key for selector model", "warning");
    return null;
  }

  try {
    return await ctx.ui.custom<{ tier: Tier; taskModelId: string; thinkingLevel: ThinkingLevel } | null>(
      (tui, theme, _kb, done) => {
        const loader = new BorderedLoader(
          tui,
          theme,
          `Selecting model (${config.models.selector})...`,
        );
        loader.onAbort = () => done(null);

        const doSelect = async () => {
          const selectorTimeout = AbortSignal.timeout(10_000);
          const combined = AbortSignal.any([selectorTimeout, loader.signal]);

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
          const taskModelId = config.models[tier];
          const taskModel = resolveModel(ctx, taskModelId);
          if (!taskModel) {
            ctx.ui.notify(`Router: task model "${taskModelId}" not found`, "warning");
            return null;
          }

          const success = await pi.setModel(taskModel);
          if (!success) {
            ctx.ui.notify(`Router: no API key for ${taskModelId}`, "warning");
            return null;
          }

          const thinkingLevel = config.thinkingLevel[tier];
          pi.setThinkingLevel(thinkingLevel);

          return { tier, taskModelId, thinkingLevel };
        };

        doSelect().then(done).catch(() => done(null));
        return loader;
      },
    );
  } catch (err) {
    console.error("[dynamic-model-router] Selector call failed:", err);
    ctx.ui.notify("Router: selector call failed, using current model", "warning");
    return null;
  }
}
