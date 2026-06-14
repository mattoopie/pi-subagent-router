import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

export const DEFAULT_CONFIG: RouterConfig = {
  models: {
    selector: "opencode-go/deepseek-v4-flash",
    complex: "opencode-go/mimo-v2.5-pro",
    medium: "opencode-go/mimo-v2.5-pro",
    easy: "opencode-go/deepseek-v4-flash",
    summarization: "opencode-go/deepseek-v4-flash",
  },
  summarizeOnEverySwitch: true,
  maxRecentTurns: 2,
};

export function loadConfig(cwd: string): RouterConfig {
  // 1. Check PI_ROUTER_CONFIG env var
  const envConfigPath = process.env.PI_ROUTER_CONFIG;
  if (envConfigPath && existsSync(envConfigPath)) {
    try {
      const raw = readFileSync(envConfigPath, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      console.error(`[dynamic-model-router] Failed to parse PI_ROUTER_CONFIG: ${err}`);
    }
  }

  // 2. Check .pi/dynamic-model-router.json in cwd
  const projectConfigPath = join(cwd, ".pi", "dynamic-model-router.json");
  if (existsSync(projectConfigPath)) {
    try {
      const raw = readFileSync(projectConfigPath, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      console.error(`[dynamic-model-router] Failed to parse project config: ${err}`);
    }
  }

  // 3. Fall back to defaults
  return DEFAULT_CONFIG;
}
