import type { Hono } from "hono";
import type { workspaceStore } from "../../state/workspace.js";

export function registerGetWorkspace(
  app: Hono,
  {
    workspace,
  }: {
    workspace: Pick<ReturnType<typeof workspaceStore>, "get">;
  },
) {
  app.get("/api/workspace", (c) => c.json(workspace.get()));
}
