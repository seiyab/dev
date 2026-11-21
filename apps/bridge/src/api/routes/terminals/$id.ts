import type { Hono } from "hono";
import { parseLayout } from "@workbench/protocol";
import type { workspaceStore } from "../../state/workspace.js";
import type { createTerminalState } from "../../state/terminals.js";
import type { createTmux } from "../../tmux.js";

export function registerTerminal(
  app: Hono,
  {
    workspace,
    terminalState,
    tmux,
  }: {
    workspace: ReturnType<typeof workspaceStore>;
    terminalState: ReturnType<typeof createTerminalState>;
    tmux: ReturnType<typeof createTmux>;
  },
) {
  app.get("/api/terminals/:id", async (c) => {
    const resource = workspace
      .get()
      .terminals.find((t) => t.id === c.req.param("id"));
    if (!resource) return c.text("Unknown terminal", 404);
    return c.json({
      ...resource,
      active: terminalState.controllers.has(resource.id),
      running: await tmux.running(resource.id),
    });
  });
  app.delete("/api/terminals/:id", async (c) => {
    const id = c.req.param("id");
    if (terminalState.deleting.has(id))
      return c.text("Terminal is being terminated", 409);
    const state = workspace.get();
    if (!state.terminals.some((t) => t.id === id))
      return c.text("Unknown terminal", 404);
    if (terminalState.controllers.has(id))
      return c.text("Disconnect the terminal before terminating it", 409);
    // This also prevents an old client from killing a currently visible resource.
    const remaining = state.terminals.filter((t) => t.id !== id);
    if (
      state.sessions.some(
        (s) =>
          !parseLayout(
            s.layout,
            remaining.filter((t) => t.sessionId === s.id),
          ),
      )
    )
      return c.text("Close the pane before terminating its terminal", 409);
    terminalState.deleting.add(id);
    try {
      try {
        await tmux.kill(id);
      } catch {
        /* Already ended. */
      }
      const current = workspace.get();
      return c.json(
        workspace.update(
          {
            ...current,
            terminals: current.terminals.filter((t) => t.id !== id),
          },
          false,
        ),
      );
    } finally {
      terminalState.deleting.delete(id);
    }
  });
}
