import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseLayout,
  validId,
  MAX_TERMINALS,
  type WorkspaceState,
} from "@workbench/protocol";

export function workspaceStore(stateDir: string) {
  const file = resolve(stateDir, "workspace.json");
  function persist(next: WorkspaceState) {
    writeFileSync(file + ".tmp", JSON.stringify(next) + "\n", { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  let state: WorkspaceState;
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as WorkspaceState;
    if (
      stored.version !== 1 ||
      !Number.isSafeInteger(stored.revision) ||
      stored.revision < 0 ||
      !Array.isArray(stored.terminals) ||
      stored.terminals.length > MAX_TERMINALS ||
      stored.terminals.some(
        (t) =>
          !validId(t.id) ||
          typeof t.title !== "string" ||
          t.title.length > 80 ||
          typeof t.started !== "boolean",
      ) ||
      new Set(stored.terminals.map((t) => t.id)).size !==
        stored.terminals.length
    )
      throw new Error("Invalid workspace metadata");
    const layout = parseLayout(stored.layout, stored.terminals);
    if (!layout) throw new Error("Invalid workspace layout");
    state = { ...stored, layout };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Reuse the original prototype's tmux session on upgrade.
    state = {
      version: 1,
      revision: 0,
      terminals: [{ id: "terminal", title: "Terminal 1", started: false }],
      layout: {
        root: { type: "terminal", id: "terminal" },
        activeId: "terminal",
        zoomedId: null,
      },
    };
    persist(state);
  }
  return {
    get: () => state,
    update: (next: WorkspaceState, reviseLayout = true) => {
      const updated = {
        ...next,
        revision: state.revision + (reviseLayout ? 1 : 0),
      };
      persist(updated);
      state = updated;
      return state;
    },
  };
}
