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

export type ConfigSource = "env" | "project" | "default";

export const DEFAULT_CONFIG: RouterConfig = Object.freeze({
  models: Object.freeze({
    selector: "opencode-go/deepseek-v4-flash",
    complex: "opencode-go/mimo-v2.5-pro",
    medium: "opencode-go/mimo-v2.5-pro",
    easy: "opencode-go/deepseek-v4-flash",
    summarization: "opencode-go/deepseek-v4-flash",
  }),
  summarizeOnEverySwitch: true,
  maxRecentTurns: 2,
}) as RouterConfig;

export function loadConfig(cwd: string): { config: RouterConfig; source: ConfigSource } {
  // 1. Check PI_ROUTER_CONFIG env var
  const envConfigPath = process.env.PI_ROUTER_CONFIG;
  if (envConfigPath && existsSync(envConfigPath)) {
    const result = loadConfigFile(envConfigPath);
    if (result) {
      return { config: result, source: "env" };
    }
  }

  // 2. Check .pi/dynamic-model-router.json in cwd
  const projectConfigPath = join(cwd, ".pi", "dynamic-model-router.json");
  if (existsSync(projectConfigPath)) {
    const result = loadConfigFile(projectConfigPath);
    if (result) {
      return { config: result, source: "project" };
    }
  }

  // 3. Fall back to defaults
  return { config: DEFAULT_CONFIG, source: "default" };
}

function loadConfigFile(path: string): RouterConfig | undefined {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return validateAndMerge(parsed);
  } catch (err) {
    console.error(`[dynamic-model-router] Failed to load config from ${path}: ${err}`);
    return undefined;
  }
}

/**
 * Validate parsed JSON and merge with defaults.
 * Returns undefined if validation fails (caller should fall back to defaults).
 */
function validateAndMerge(parsed: unknown): RouterConfig | undefined {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error("[dynamic-model-router] Config must be a JSON object");
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  const result: RouterConfig = { ...DEFAULT_CONFIG };

  // Validate and merge top-level boolean/number fields
  if ("summarizeOnEverySwitch" in raw) {
    if (typeof raw.summarizeOnEverySwitch !== "boolean") {
      console.error("[dynamic-model-router] summarizeOnEverySwitch must be a boolean");
      return undefined;
    }
    result.summarizeOnEverySwitch = raw.summarizeOnEverySwitch;
  }

  if ("maxRecentTurns" in raw) {
    if (typeof raw.maxRecentTurns !== "number" || raw.maxRecentTurns < 0 || !Number.isInteger(raw.maxRecentTurns)) {
      console.error("[dynamic-model-router] maxRecentTurns must be a non-negative integer");
      return undefined;
    }
    result.maxRecentTurns = raw.maxRecentTurns;
  }

  // Validate and merge models
  if ("models" in raw) {
    if (typeof raw.models !== "object" || raw.models === null || Array.isArray(raw.models)) {
      console.error("[dynamic-model-router] models must be an object");
      return undefined;
    }
    const rawModels = raw.models as Record<string, unknown>;
    const validKeys: (keyof RouterModels)[] = ["selector", "complex", "medium", "easy", "summarization"];
    const models: RouterModels = { ...DEFAULT_CONFIG.models };

    for (const key of validKeys) {
      if (key in rawModels) {
        if (typeof rawModels[key] !== "string") {
          console.error(`[dynamic-model-router] models.${key} must be a string`);
          return undefined;
        }
        (models as Record<string, string>)[key] = rawModels[key] as string;
      }
    }

    // Warn about unknown keys
    for (const key of Object.keys(rawModels)) {
      if (!validKeys.includes(key as keyof RouterModels)) {
        console.warn(`[dynamic-model-router] Unknown config key: models.${key}`);
      }
    }

    result.models = models;
  }

  return result;
}
