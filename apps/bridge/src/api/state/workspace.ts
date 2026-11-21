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
  const loaded = loadWorkspace(file, workspaceDir);
  let state = loaded?.state ?? createDefaultWorkspace(workspaceDir);
  if (!loaded || loaded.migrated) saveWorkspace(file, state);

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
      saveWorkspace(file, updated);
      state = updated;
      return state;
    },
  };
}

function createDefaultWorkspace(workspaceDir: string): WorkspaceState {
  // Reuse the original prototype's tmux session on upgrade.
  const state: WorkspaceState = {
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
  return state;
}

function saveWorkspace(file: string, state: WorkspaceState) {
  writeFileSync(file + ".tmp", JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(file + ".tmp", file);
}

function loadWorkspace(file: string, workspaceDir: string) {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const stored = JSON.parse(content) as WorkspaceState;
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
    new Set(stored.terminals.map((t) => t.id)).size !== stored.terminals.length
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
    new Set(stored.sessions.map((s) => s.id)).size !== stored.sessions.length ||
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
  const state: WorkspaceState = { ...stored, version: 2, layout };
  return { state, migrated: (stored.version as number) === 1 };
}
