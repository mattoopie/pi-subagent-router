import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete } from "@earendil-works/pi-ai";
import type { Model, Api } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { ResolvedRequestAuth } from "@earendil-works/pi-coding-agent";

const SUMMARY_SYSTEM_PROMPT = `You are a conversation summarizer for a coding agent. Create a comprehensive summary of the conversation that captures:

1. Goals and objectives
2. Key decisions made and their rationale
3. Files read/modified (extract from tool calls)
4. Current state of work
5. Recent tool calls and their results (for continuity)
6. Any blockers, issues, or open questions

Be thorough but concise. The summary will be prepended to a new context so the LLM can continue the work effectively.

Format the summary as structured markdown with clear sections.`;

export async function generateSummary(
  model: Model<Api>,
  auth: ResolvedRequestAuth,
  messages: AgentMessage[],
  signal?: AbortSignal,
): Promise<string | null> {
  if (messages.length === 0) return null;

  // Convert to LLM format and serialize to readable text
  const llmMessages = convertToLlm(messages);
  const conversationText = serializeConversation(llmMessages);

  if (!conversationText.trim()) return null;

  try {
    const response = await complete(
      model,
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: conversationText }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 2000,
        signal,
      },
    );

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return text.trim() || null;
  } catch (err) {
    if (signal?.aborted) return null;
    console.error("[dynamic-model-router] Summarization failed:", err);
    return null;
  }
}

/**
 * Extract the last N complete turns (user+assistant pairs) from the end of the messages.
 * Returns the recent messages to keep verbatim.
 */
export function extractRecentTurns(messages: AgentMessage[], n: number): AgentMessage[] {
  if (n <= 0 || messages.length === 0) return [];

  // Walk backwards collecting complete turns
  let turnCount = 0;
  let i = messages.length - 1;

  // Start from the last message and walk back
  // A "turn" is a user message followed by assistant responses
  while (i >= 0 && turnCount < n) {
    const msg = messages[i];
    if (msg.role === "user") {
      turnCount++;
    }
    i--;
  }

  // If we didn't find enough turns, return all messages
  if (turnCount < n) return [...messages];

  // i is now just before the first message we want to keep
  return messages.slice(i + 1);
}
