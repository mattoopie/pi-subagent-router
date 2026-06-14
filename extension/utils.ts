import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import type { RouterConfig, Tier } from "./config.ts";

/**
 * Resolve a "provider/model-id" spec to a Model from the registry.
 */
export function resolveModel(ctx: ExtensionContext, modelSpec: string): Model<Api> | undefined {
  const slashIdx = modelSpec.indexOf("/");
  if (slashIdx < 0) {
    console.error(`[dynamic-model-router] Invalid model spec: "${modelSpec}" (expected "provider/model-id")`);
    return undefined;
  }
  const provider = modelSpec.slice(0, slashIdx);
  const modelId = modelSpec.slice(slashIdx + 1);
  return ctx.modelRegistry.find(provider, modelId);
}

/**
 * Find which tier a model is configured for, or undefined if it's not a task model.
 */
export function findTierForModel(config: RouterConfig, modelId: string): Tier | undefined {
  if (config.models.complex === modelId) return "complex";
  if (config.models.medium === modelId) return "medium";
  if (config.models.easy === modelId) return "easy";
  return undefined;
}
