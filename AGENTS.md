# AGENTS.md

## Overview

A [pi](https://github.com/earendil-works/pi) extension that dynamically routes user prompts to different models based on task complexity. On model switches, it summarizes prior context so the new model picks up seamlessly.

## Repository Structure

```
extension/
  index.ts            Thin orchestrator — wires event handlers to the modules below
  config.ts           Config loading, validation, defaults, types (Tier, RouterConfig, etc.)
  router-state.ts     RouterState class — mutable state + session/persistent persistence
  selector.ts         Classification pipeline — prompt enrichment, selector call, model switch
  context-manager.ts  Summarization decisions, execution, injection, and context filtering
  commands.ts         /router and /router-toggle slash commands, message renderers
  summarizer.ts       LLM summarization call and recent-turn extraction (used by context-manager)
  utils.ts            Shared helpers: resolveModel(), findTierForModel()
```

Data flows through these modules in a single direction:

```
index.ts (event handlers)
  → selector.ts        (classify + switch model)
  → context-manager.ts (decide + run summarization, filter context)
  → commands.ts        (UI commands read state)
  → router-state.ts    (all modules read/write state via the RouterState instance)
  → config.ts          (read-only after session_start)
  → summarizer.ts      (called by context-manager)
  → utils.ts           (pure helpers)
```

No circular dependencies.

## How to Work With This Repo

### Install the extension

```bash
# When working on the extension
pi install .

# When installing from another project
pi install git:github.com/mattoopie/pi-subagent-router@v1.0.0
```

The `pi.extensions` field in `package.json` points to `./extension/index.ts`. pi loads it as a TypeScript extension directly — no build step.

### Configure

Create `.pi/dynamic-model-router.json` in the target project, or set `PI_ROUTER_CONFIG` to an absolute path. See the README for the full schema. Sensible defaults ship in `config.ts` if no file is found.

### Toggle on/off

Use `/router-toggle` in a pi session. The toggle state persists to `.pi/router-toggle-state.json` (should be gitignored).

### Check status

Use `/router` in a pi session to see the active config source, current model, turn count, and tier assignments.

## Key Design Decisions

- **State is centralized** in a single `RouterState` instance created in `index.ts` and passed by reference. All modules that need state receive it as a parameter — no global singletons.
- **Config is loaded once** at `session_start` and captured in a closure. Commands access it via getter functions so they always read the current values.
- **No build step.** pi runs the `.ts` files directly via its Bun runtime. There is no `tsc`, no `dist/`, no build script.
- **Built-in compaction is cancelled** (`session_before_compact` returns `{ cancel: true }`) because the extension manages context itself via summarization.
