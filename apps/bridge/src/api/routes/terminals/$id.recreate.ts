import type { Hono } from "hono";
import type { workspaceStore } from "../../state/workspace.js";
import type { createTerminalState } from "../../state/terminals.js";
import type { createTmux } from "../../tmux.js";

export function registerRecreateTerminal(
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
  app.post("/api/terminals/:id/recreate", async (c) => {
    const resource = workspace
      .get()
      .terminals.find((t) => t.id === c.req.param("id"));
    if (!resource) return c.text("Unknown terminal", 404);
    if (
      terminalState.deleting.has(resource.id) ||
      (await tmux.running(resource.id)) ||
      terminalState.controllers.has(resource.id)
    )
      return c.text("Terminal is still running", 409);
    return c.json(
      workspace.update(
        {
          ...workspace.get(),
          terminals: workspace
            .get()
            .terminals.map((t) =>
              t.id === resource.id ? { ...t, started: false } : t,
            ),
        },
        false,
      ),
    );
  });
}
