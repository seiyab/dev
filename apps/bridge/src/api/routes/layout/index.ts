import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { parseLayout, paneIds } from "@workbench/protocol";
import type { workspaceStore } from "../../state/workspace.js";
import type { createTerminalState } from "../../state/terminals.js";

export function registerUpdateLayout(
  app: Hono,
  {
    workspace,
    terminalState,
  }: {
    workspace: ReturnType<typeof workspaceStore>;
    terminalState: ReturnType<typeof createTerminalState>;
  },
) {
  app.put("/api/layout", bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.text("Invalid request", 400);
    }
    if (terminalState.deletingSession)
      return c.text("Session deletion in progress", 409);
    if (!body || body.revision !== workspace.get().revision)
      return c.text(
        "Workspace changed in another client. Reload to continue.",
        409,
      );
    if (
      body.sessionId !== undefined &&
      body.sessionId !== workspace.get().selectedSessionId
    )
      return c.text("Session changed", 409);
    const layout = parseLayout(
      body.layout,
      workspace
        .get()
        .terminals.filter(
          (t) => t.sessionId === workspace.get().selectedSessionId,
        ),
    );
    if (!layout) return c.text("Invalid layout", 400);
    if (paneIds(layout.root).some((id) => terminalState.deleting.has(id)))
      return c.text("Terminal is being terminated", 409);
    return c.json(workspace.update({ ...workspace.get(), layout }));
  });
}
