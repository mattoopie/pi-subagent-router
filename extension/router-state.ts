import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const STATE_ENTRY_TYPE = "router-state";
const PERSISTENT_STATE_FILE = ".pi/router-toggle-state.json";

interface SavedState {
  turnCount: number;
  previousModelId?: string;
  currentTaskModelId?: string;
  routerEnabled?: boolean;
}

/**
 * Encapsulates all mutable router state and persistence logic.
 */
export class RouterState {
  turnCount = 0;
  previousModelId: string | undefined;
  currentTaskModelId: string | undefined;
  needsSummary = false;
  pendingSummary: string | null = null;
  stateDirty = false;
  routerEnabled = true;

  private persistentStatePath: string | undefined;
  private pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
  }

  /** Reset all state to defaults and set the persistent state path for this session. */
  reset(cwd: string): void {
    this.turnCount = 0;
    this.previousModelId = undefined;
    this.currentTaskModelId = undefined;
    this.needsSummary = false;
    this.pendingSummary = null;
    this.stateDirty = false;
    this.routerEnabled = true;
    this.persistentStatePath = join(cwd, PERSISTENT_STATE_FILE);
  }

  /** Walk the session branch backwards to restore the last saved state entry. */
  restoreFromSession(branch: Array<{ type: string; customType?: string; data?: unknown }>): void {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE) {
        const data = entry.data as SavedState | undefined;
        if (data) {
          this.turnCount = data.turnCount ?? 0;
          this.previousModelId = data.previousModelId;
          this.currentTaskModelId = data.currentTaskModelId;
          if (data.routerEnabled !== undefined) {
            this.routerEnabled = data.routerEnabled;
          }
        }
        break;
      }
    }

    // Persistent file takes precedence (survives across sessions)
    const persistentToggle = this.loadPersistentToggle();
    if (persistentToggle !== undefined) {
      this.routerEnabled = persistentToggle;
    }
  }

  /** Persist state to the session log if dirty. */
  saveSessionState(): void {
    if (!this.stateDirty) return;
    this.pi.appendEntry(STATE_ENTRY_TYPE, {
      turnCount: this.turnCount,
      previousModelId: this.previousModelId,
      currentTaskModelId: this.currentTaskModelId,
      routerEnabled: this.routerEnabled,
    });
    this.stateDirty = false;
  }

  /** Persist the toggle state to disk so it survives new sessions. */
  savePersistentToggle(): void {
    if (!this.persistentStatePath) return;
    try {
      const dir = dirname(this.persistentStatePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.persistentStatePath, JSON.stringify({ routerEnabled: this.routerEnabled }), "utf-8");
    } catch (err) {
      console.error("[dynamic-model-router] Failed to save toggle state:", err);
    }
  }

  private loadPersistentToggle(): boolean | undefined {
    if (!this.persistentStatePath || !existsSync(this.persistentStatePath)) return undefined;
    try {
      const raw = readFileSync(this.persistentStatePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.routerEnabled === "boolean") {
        return parsed.routerEnabled;
      }
    } catch (err) {
      console.error("[dynamic-model-router] Failed to load toggle state:", err);
    }
    return undefined;
  }

  /** Flip the router enabled/disabled flag and mark state dirty. */
  toggle(): void {
    this.routerEnabled = !this.routerEnabled;
    this.stateDirty = true;
  }

  markDirty(): void {
    this.stateDirty = true;
  }
}
