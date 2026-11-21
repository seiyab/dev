import type { Hono } from "hono";
import { PROTOCOL_VERSION } from "@workbench/protocol";
import type { createTerminalState } from "../../state/terminals.js";

export function registerGetSession(
  app: Hono,
  {
    terminalState,
  }: {
    terminalState: ReturnType<typeof createTerminalState>;
  },
) {
  app.get("/api/session", (c) =>
    c.json({
      version: PROTOCOL_VERSION,
      active: terminalState.controllers.has("terminal"),
    }),
  );
}
