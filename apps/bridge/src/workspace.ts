import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseLayout,
  validId,
  MAX_TERMINALS,
  type WorkspaceState,
} from "@workbench/protocol";

export function workspaceStore(stateDir: string, workspaceDir: string) {
  const file = resolve(stateDir, "workspace.json");
  function persist(next: WorkspaceState) {
    writeFileSync(file + ".tmp", JSON.stringify(next) + "\n", { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  let state: WorkspaceState;
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as WorkspaceState;
    if (
      ![1, 2].includes(stored.version) ||
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
    // Upgrade the original single-workspace state without replacing its terminals.
    if ((stored.version as number) === 1 && !stored.sessions) {
      stored.sessions = [
        {
          id: "default",
          name: "Default",
          directory: workspaceDir,
          archived: false,
          layout,
        },
      ];
      stored.selectedSessionId = "default";
      stored.terminals = stored.terminals.map((t) => ({
        ...t,
        sessionId: "default",
      }));
    }
    if (
      !Array.isArray(stored.sessions) ||
      stored.sessions.length > 64 ||
      new Set(stored.sessions.map((s) => s.id)).size !==
        stored.sessions.length ||
      stored.sessions.some(
        (s) =>
          !validId(s.id) ||
          typeof s.name !== "string" ||
          !s.name.trim() ||
          s.name.length > 80 ||
          typeof s.directory !== "string" ||
          !s.directory.startsWith("/") ||
          typeof s.archived !== "boolean" ||
          !parseLayout(
            s.layout,
            stored.terminals.filter((t) => t.sessionId === s.id),
          ),
      ) ||
      stored.terminals.some(
        (t) => !stored.sessions.some((s) => s.id === t.sessionId),
      ) ||
      (stored.selectedSessionId !== null &&
        !stored.sessions.some(
          (s) => s.id === stored.selectedSessionId && !s.archived,
        ))
    )
      throw new Error("Invalid work sessions");
    stored.sessions = stored.sessions.map((s) => ({
      ...s,
      layout: parseLayout(
        s.layout,
        stored.terminals.filter((t) => t.sessionId === s.id),
      )!,
    }));
    const selected = stored.sessions.find(
      (s) => s.id === stored.selectedSessionId,
    );
    if (
      JSON.stringify(
        selected?.layout ?? { root: null, activeId: null, zoomedId: null },
      ) !== JSON.stringify(layout)
    )
      throw new Error("Invalid selected layout");
    state = { ...stored, version: 2, layout };
    if ((stored.version as number) === 1) persist(state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // Reuse the original prototype's tmux session on upgrade.
    state = {
      version: 2,
      sessions: [],
      selectedSessionId: "default",
      revision: 0,
      terminals: [
        {
          id: "terminal",
          title: "Terminal 1",
          started: false,
          sessionId: "default",
        },
      ],
      layout: {
        root: { type: "terminal", id: "terminal" },
        activeId: "terminal",
        zoomedId: null,
      },
    };
    state.sessions = [
      {
        id: "default",
        name: "Default",
        directory: workspaceDir,
        archived: false,
        layout: state.layout,
      },
    ];
    persist(state);
  }
  return {
    get: () => state,
    update: (next: WorkspaceState, revise = true) => {
      const updated = {
        ...next,
        sessions: next.sessions.map((s) =>
          s.id === next.selectedSessionId ? { ...s, layout: next.layout } : s,
        ),
        revision: state.revision + (revise ? 1 : 0),
      };
      persist(updated);
      state = updated;
      return state;
    },
  };
}
