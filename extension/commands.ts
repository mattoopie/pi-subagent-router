import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RouterConfig, ConfigSource } from "./config.ts";
import type { RouterState } from "./router-state.ts";

/**
 * Register the custom message renderer for expandable summary messages.
 */
export function registerMessageRenderers(pi: ExtensionAPI): void {
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
}

/**
 * Register the /router and /router-toggle slash commands.
 * Uses getter functions for config so commands always read the current values.
 */
export function registerCommands(
  pi: ExtensionAPI,
  state: RouterState,
  getConfig: () => RouterConfig,
  getConfigSource: () => ConfigSource,
): void {
  pi.registerCommand("router", {
    description: "Show dynamic model router status and config",
    handler: async (_args, ctx) => {
      if (!state.routerEnabled) {
        ctx.ui.notify("Router is OFF (use /router-toggle to enable)", "info");
        return;
      }

      const config = getConfig();
      const lines = [
        "Router is ON",
        `Config source: ${getConfigSource()}`,
        `Selector: ${config.models.selector}`,
        `Models: complex=${config.models.complex}, medium=${config.models.medium}, easy=${config.models.easy}`,
        `Summarization: ${config.models.summarization}`,
        `Turn: ${state.turnCount}, Current model: ${ctx.model?.id ?? "none"}`,
        `Thinking levels: complex=${config.thinkingLevel.complex}, medium=${config.thinkingLevel.medium}, easy=${config.thinkingLevel.easy}`,
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

  pi.registerCommand("router-toggle", {
    description: "Toggle the dynamic model router on/off",
    handler: async (_args, ctx) => {
      state.toggle();
      state.saveSessionState();
      state.savePersistentToggle();

      if (state.routerEnabled) {
        ctx.ui.notify("🔄 Router enabled", "info");
        ctx.ui.setStatus("router", ctx.ui.theme.fg("accent", "🔄 dynamic"));
      } else {
        ctx.ui.notify("⏸ Router disabled", "info");
        ctx.ui.setStatus("router", ctx.ui.theme.fg("dim", "⏸ router off"));
      }
    },
  });
}
