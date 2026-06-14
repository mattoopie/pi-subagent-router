/**
 * Dynamic Model Router Extension
 *
 * Intercepts each user prompt, classifies its complexity using a cheap "selector" model,
 * routes it to the appropriate task model, and manages context via summarization when
 * models switch. Everything stays in one session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type RouterConfig, type ConfigSource } from "./config.ts";
import { RouterState } from "./router-state.ts";
import { runSelector } from "./selector.ts";
import { shouldSummarize, runSummarization, buildBeforeAgentStartPayload, filterContextMessages } from "./context-manager.ts";
import { registerCommands, registerMessageRenderers } from "./commands.ts";
import { findTierForModel } from "./utils.ts";

export default function (pi: ExtensionAPI) {
  let config: RouterConfig;
  let configSource: ConfigSource = "default";
  const state = new RouterState(pi);

  // ── Register UI components ──
  registerMessageRenderers(pi);
  registerCommands(pi, state, () => config, () => configSource);

  // ── Session lifecycle ──
  pi.on("session_start", async (_event, ctx) => {
    state.reset(ctx.cwd);
    state.restoreFromSession(ctx.sessionManager.getBranch());

    const loaded = loadConfig(ctx.cwd);
    config = loaded.config;
    configSource = loaded.source;

    if (!state.routerEnabled) {
      ctx.ui.setStatus("router", ctx.ui.theme.fg("dim", "⏸ router off"));
    } else if (state.currentTaskModelId) {
      const tier = findTierForModel(config, state.currentTaskModelId);
      ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier ?? "dynamic"}`));
    } else {
      ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", "🔄 dynamic"));
    }
  });

  pi.on("session_shutdown", async () => {
    state.saveSessionState();
  });

  pi.on("session_before_compact", async () => {
    return { cancel: true };
  });

  // ── Status on model change ──
  pi.on("model_select", async (event, ctx) => {
    const tier = findTierForModel(config, `${event.model.provider}/${event.model.id}`);
    ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier ?? "dynamic"}`));
  });

  // ── Input: classify and route ──
  pi.on("input", async (event, ctx) => {
    if (!state.routerEnabled) return { action: "continue" };
    if (event.source !== "interactive") return { action: "continue" };
    if (event.streamingBehavior) return { action: "continue" };

    state.turnCount++;
    state.markDirty();

    const result = await runSelector(pi, ctx, config, event.text);

    if (result) {
      const { tier, taskModelId, thinkingLevel } = result;

      if (shouldSummarize(state, config, ctx, taskModelId)) {
        state.needsSummary = true;
        const summary = await runSummarization(ctx, config);
        if (summary) {
          state.pendingSummary = summary;
        }
      }

      state.previousModelId = taskModelId;
      state.currentTaskModelId = taskModelId;

      ctx.ui.notify(`⚡ Model: ${taskModelId.split("/").pop()} (${tier}, thinking: ${thinkingLevel})`, "info");
      ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", `🔄 ${tier}`));
    } else {
      ctx.ui.notify("Router: selection cancelled or failed", "warning");
    }

    state.saveSessionState();
    return { action: "continue" };
  });

  // ── Inject summary before agent loop ──
  pi.on("before_agent_start", async () => {
    return buildBeforeAgentStartPayload(state);
  });

  // ── Filter old messages on model switch ──
  pi.on("context", async (event) => {
    return filterContextMessages(event.messages, config, state);
  });
}
