import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { bodyLimit } from "hono/body-limit";
import { MAX_TERMINALS } from "@workbench/protocol";
import type { workspaceStore } from "../../state/workspace.js";
import type { createTerminalState } from "../../state/terminals.js";
import type { createTmux } from "../../tmux.js";

export function registerUpdateSessions(
  app: Hono,
  {
    workspace,
    terminalState,
    tmux,
    workspaceDir,
  }: {
    workspace: ReturnType<typeof workspaceStore>;
    terminalState: ReturnType<typeof createTerminalState>;
    tmux: ReturnType<typeof createTmux>;
    workspaceDir: string;
  },
) {
  app.post("/api/sessions", bodyLimit({ maxSize: 4096 }), async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.text("Invalid request", 400);
    }
    if (terminalState.deletingSession)
      return c.text("Session deletion in progress", 409);
    const state = workspace.get();
    if (!body || body.revision !== state.revision)
      return c.text(
        "Workspace changed in another client. Reload to continue.",
        409,
      );
    const empty = { root: null, activeId: null, zoomedId: null };
    if (body.action === "create") {
      if (
        state.sessions.length >= 64 ||
        state.terminals.length >= MAX_TERMINALS
      )
        return c.text("Session or terminal limit reached", 409);
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.trim().length > 80 ||
        typeof body.directory !== "string" ||
        !body.directory ||
        body.directory.length > 4096
      )
        return c.text(
          "A name and existing workspace directory are required",
          400,
        );
      let directory: string;
      try {
        const root = realpathSync(workspaceDir);
        directory = realpathSync(resolve(root, body.directory));
        const path = relative(root, directory);
        if (
          path === ".." ||
          path.startsWith("../") ||
          isAbsolute(path) ||
          !statSync(directory).isDirectory()
        )
          throw new Error();
      } catch {
        return c.text("Choose an existing directory within the workspace", 400);
      }
      const id = randomBytes(16).toString("hex");
      const terminal = {
        id: randomBytes(16).toString("hex"),
        title: "Terminal 1",
        started: false,
        sessionId: id,
      };
      const layout = {
        root: { type: "terminal" as const, id: terminal.id },
        activeId: terminal.id,
        zoomedId: null,
      };
      return c.json(
        workspace.update({
          ...state,
          selectedSessionId: id,
          layout,
          terminals: [...state.terminals, terminal],
          sessions: [
            ...state.sessions,
            { id, name: body.name.trim(), directory, archived: false, layout },
          ],
        }),
        201,
      );
    }
    const session = state.sessions.find((s) => s.id === body.id);
    if (!session) return c.text("Unknown session", 404);
    if (body.action === "select") {
      return c.json(
        workspace.update({
          ...state,
          selectedSessionId: session.id,
          layout: session.layout,
          sessions: state.sessions.map((s) =>
            s.id === session.id ? { ...s, archived: false } : s,
          ),
        }),
      );
    }
    if (body.action === "rename") {
      if (
        typeof body.name !== "string" ||
        !body.name.trim() ||
        body.name.trim().length > 80
      )
        return c.text("Name must contain 1–80 characters", 400);
      return c.json(
        workspace.update({
          ...state,
          sessions: state.sessions.map((s) =>
            s.id === session.id ? { ...s, name: body.name.trim() } : s,
          ),
        }),
      );
    }
    if (body.action !== "archive" && body.action !== "delete")
      return c.text("Unknown action", 400);
    if (body.action === "delete") {
      terminalState.deletingSession = true;
      const terminals = state.terminals.filter(
        (t) => t.sessionId === session.id,
      );
      terminals.forEach((t) => {
        terminalState.deleting.add(t.id);
        terminalState.controllers.get(t.id)?.();
      });
      try {
        for (const t of terminals) {
          try {
            await tmux.kill(t.id);
          } catch {
            if (await tmux.running(t.id))
              return c.text(
                "Unable to terminate session terminals. Retry deletion.",
                500,
              );
          }
        }
      } finally {
        terminals.forEach((t) => terminalState.deleting.delete(t.id));
        terminalState.deletingSession = false;
      }
    }
    // Read again after terminating processes: attachment cleanup may have updated metadata.
    const current = workspace.get();
    const remaining =
      body.action === "delete"
        ? current.sessions.filter((s) => s.id !== session.id)
        : current.sessions.map((s) =>
            s.id === session.id ? { ...s, archived: true } : s,
          );
    const selected =
      current.selectedSessionId === session.id
        ? remaining.find((s) => !s.archived)
        : remaining.find((s) => s.id === current.selectedSessionId);
    return c.json(
      workspace.update({
        ...current,
        sessions: remaining,
        terminals:
          body.action === "delete"
            ? current.terminals.filter((t) => t.sessionId !== session.id)
            : current.terminals,
        selectedSessionId: selected?.id ?? null,
        layout: selected?.layout ?? empty,
      }),
    );
  });
}
