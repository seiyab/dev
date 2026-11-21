import type { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { bodyLimit } from "hono/body-limit";
import { MAX_TERMINALS } from "@workbench/protocol";
import type { workspaceStore } from "../../state/workspace.js";
import type { createTerminalState } from "../../state/terminals.js";

export function registerCreateTerminal(
  app: Hono,
  {
    workspace,
    terminalState,
  }: {
    workspace: ReturnType<typeof workspaceStore>;
    terminalState: ReturnType<typeof createTerminalState>;
  },
) {
  app.post("/api/terminals", bodyLimit({ maxSize: 1024 }), async (c) => {
    let body;
    try {
      const text = await c.req.text();
      body = text ? JSON.parse(text) : undefined;
    } catch {
      return c.text("Invalid request", 400);
    }
    if (terminalState.deletingSession)
      return c.text("Session deletion in progress", 409);
    const state = workspace.get();
    if (
      body?.sessionId !== undefined &&
      body.sessionId !== state.selectedSessionId
    )
      return c.text("Session changed. Reload to continue.", 409);
    if (state.terminals.length >= MAX_TERMINALS)
      return c.text(
        "Terminal limit reached. Terminate a detached terminal first.",
        409,
      );
    if (!state.selectedSessionId) return c.text("Select a session first", 409);
    const resource = {
      sessionId: state.selectedSessionId,
      id: randomBytes(16).toString("hex"),
      title: `Terminal ${Math.max(0, ...state.terminals.map((t) => Number(t.title.replace("Terminal ", "")) || 0)) + 1}`,
      started: false,
    };
    workspace.update(
      { ...state, terminals: [...state.terminals, resource] },
      false,
    );
    return c.json(resource, 201);
  });
}
