import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface TaskDescription {
  name: string;
  description: string;
}

export interface TaskDescriptions {
  complex: TaskDescription[];
  medium: TaskDescription[];
  easy: TaskDescription[];
}

export interface RouterModels {
  selector: string;
  complex: string;
  medium: string;
  easy: string;
  summarization: string;
}

export interface RouterConfig {
  models: RouterModels;
  thinkingLevel: ThinkingLevels;
  summarizeOnEverySwitch: boolean;
  maxRecentTurns: number;
  taskDescriptions: TaskDescriptions;
}

export type ThinkingLevels = Record<Tier, ThinkingLevel>;

export type Tier = "complex" | "medium" | "easy";
export type ConfigSource = "env" | "project" | "default";

export const DEFAULT_TASK_DESCRIPTIONS: TaskDescriptions = Object.freeze({
  complex: Object.freeze([
    { name: "architecture", description: "Designing systems, planning multi-file refactors, structuring new projects" },
    { name: "complex-debugging", description: "Debugging issues that span multiple files or require deep reasoning" },
    { name: "review", description: "Reviewing code changes, features, or large parts of the codebase for quality and correctness" },
    { name: "multi-step-refactoring", description: "Refactoring that touches many files or requires careful coordination" },
  ]) as TaskDescription[],
  medium: Object.freeze([
    { name: "feature-implementation", description: "Adding or modifying functionality across one or a few files" },
    { name: "moderate-coding", description: "Coding tasks that require some thought but are well-scoped" },
    { name: "file-modifications", description: "Editing existing files with clear intent" },
  ]) as TaskDescription[],
  easy: Object.freeze([
    { name: "simple-question", description: "Quick explanations, conceptual questions, how something works" },
    { name: "formatting", description: "Reformatting, renaming, minor style changes" },
    { name: "single-file-change", description: "Small edits confined to a single file" },
    { name: "commit", description: "Writing commit messages, running git commands" },
  ]) as TaskDescription[],
}) as TaskDescriptions;

export const DEFAULT_THINKING_LEVELS: ThinkingLevels = Object.freeze({
  complex: "high",
  medium: "medium",
  easy: "off",
}) as ThinkingLevels;

export const VALID_THINKING_LEVELS: readonly ThinkingLevel[] = Object.freeze([
  "off", "minimal", "low", "medium", "high", "xhigh",
]) as ThinkingLevel[];

export const DEFAULT_CONFIG: RouterConfig = Object.freeze({
  models: Object.freeze({
    selector: "opencode-go/deepseek-v4-flash",
    complex: "opencode-go/mimo-v2.5-pro",
    medium: "opencode-go/mimo-v2.5-pro",
    easy: "opencode-go/deepseek-v4-flash",
    summarization: "opencode-go/deepseek-v4-flash",
  }),
  thinkingLevel: DEFAULT_THINKING_LEVELS,
  summarizeOnEverySwitch: true,
  maxRecentTurns: 2,
  taskDescriptions: DEFAULT_TASK_DESCRIPTIONS,
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

  // Validate and merge thinkingLevel
  if ("thinkingLevel" in raw) {
    const tl = validateThinkingLevels(raw.thinkingLevel);
    if (!tl) return undefined;
    result.thinkingLevel = tl;
  }

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

  // Validate and merge taskDescriptions
  if ("taskDescriptions" in raw) {
    const td = validateTaskDescriptions(raw.taskDescriptions);
    if (!td) return undefined;
    result.taskDescriptions = td;
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

function validateThinkingLevels(raw: unknown): ThinkingLevels | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.error("[dynamic-model-router] thinkingLevel must be an object");
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const result: ThinkingLevels = { ...DEFAULT_THINKING_LEVELS };

  for (const tier of VALID_TIERS) {
    if (tier in obj) {
      const val = obj[tier];
      if (typeof val !== "string" || !VALID_THINKING_LEVELS.includes(val as ThinkingLevel)) {
        console.error(
          `[dynamic-model-router] thinkingLevel.${tier} must be one of: ${VALID_THINKING_LEVELS.join(", ")}`,
        );
        return undefined;
      }
      result[tier] = val as ThinkingLevel;
    }
  }

  // Warn about unknown keys
  for (const key of Object.keys(obj)) {
    if (!VALID_TIERS.includes(key as Tier)) {
      console.warn(`[dynamic-model-router] Unknown key in thinkingLevel: ${key}`);
    }
  }

  return result;
}

const VALID_TIERS = ["complex", "medium", "easy"] as const;

function validateTaskDescriptions(raw: unknown): TaskDescriptions | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    console.error("[dynamic-model-router] taskDescriptions must be an object");
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const result: TaskDescriptions = { ...DEFAULT_CONFIG.taskDescriptions };

  for (const tier of VALID_TIERS) {
    if (tier in obj) {
      const arr = obj[tier];
      if (!Array.isArray(arr)) {
        console.error(`[dynamic-model-router] taskDescriptions.${tier} must be an array`);
        return undefined;
      }
      if (arr.length === 0) {
        console.error(`[dynamic-model-router] taskDescriptions.${tier} must have at least one entry`);
        return undefined;
      }
      const descriptions: TaskDescription[] = [];
      for (let i = 0; i < arr.length; i++) {
        const entry = arr[i];
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          console.error(`[dynamic-model-router] taskDescriptions.${tier}[${i}] must be an object`);
          return undefined;
        }
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== "string" || !e.name.trim()) {
          console.error(`[dynamic-model-router] taskDescriptions.${tier}[${i}].name must be a non-empty string`);
          return undefined;
        }
        if (typeof e.description !== "string" || !e.description.trim()) {
          console.error(`[dynamic-model-router] taskDescriptions.${tier}[${i}].description must be a non-empty string`);
          return undefined;
        }
        descriptions.push({ name: e.name.trim(), description: e.description.trim() });
      }
      result[tier] = descriptions;
    }
  }

  // Warn about unknown keys
  for (const key of Object.keys(obj)) {
    if (!VALID_TIERS.includes(key as Tier)) {
      console.warn(`[dynamic-model-router] Unknown key in taskDescriptions: ${key}`);
    }
  }

  return result;
}
