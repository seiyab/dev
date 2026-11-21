import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { WebSocketServer } from "ws";
import { MAX_MESSAGE_BYTES } from "@workbench/protocol";
import { createAuthState } from "./state/auth.js";
import { workspaceStore } from "./state/workspace.js";
import { createTerminalState } from "./state/terminals.js";
import { createTmux } from "./tmux.js";
import { registerLogin } from "./routes/login/index.js";
import { registerGetSession } from "./routes/session/index.js";
import { registerGetWorkspace } from "./routes/workspace/index.js";
import { registerUpdateSessions } from "./routes/sessions/index.js";
import { registerUpdateLayout } from "./routes/layout/index.js";
import { registerCreateTerminal } from "./routes/terminals/index.js";
import { registerTerminal } from "./routes/terminals/$id.js";
import { registerRecreateTerminal } from "./routes/terminals/$id.recreate.js";
import { registerTerminalWebSocket } from "./routes/terminal/index.js";

export interface BridgeConfig {
  hostname: string;
  port: number;
  origin: string;
  stateDir: string;
  workspaceDir: string;
  webRoot: string;
  shell: string;
  tmuxSocket: string;
}

export function startBridge(config: BridgeConfig) {
  const allowed = new URL(config.origin);
  if (allowed.origin !== config.origin)
    throw new Error("Origin must contain only scheme, host and port");
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.workspaceDir, { recursive: true });
  const keyFile = resolve(config.stateDir, "access-key");
  let accessKey: string;
  try {
    accessKey = readFileSync(keyFile, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    accessKey = randomBytes(32).toString("hex");
    writeFileSync(keyFile, accessKey + "\n", { mode: 0o600, flag: "wx" });
  }
  if (accessKey.length < 32)
    throw new Error("Access key must have at least 32 characters");
  const tmuxConfig = resolve(config.stateDir, "tmux.conf");
  writeFileSync(
    tmuxConfig,
    "set -g status off\nset -g prefix None\nset -g default-terminal xterm-256color\n",
    { mode: 0o600 },
  );
  const authState = createAuthState(accessKey);
  const workspace = workspaceStore(
    config.stateDir,
    realpathSync(config.workspaceDir),
  );
  const terminalState = createTerminalState();
  const tmux = createTmux(config.tmuxSocket);
  const app = new Hono();

  app.use("*", async (c, next) => {
    if (c.req.header("host") !== allowed.host)
      return c.text("Unexpected host", 403);
    await next();
    if (c.req.path !== "/api/terminal") {
      c.header("X-Content-Type-Options", "nosniff");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Cache-Control", "no-store");
      c.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    }
  });
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" || c.req.path === "/api/terminal") {
      if (c.req.header("origin") !== config.origin)
        return c.text("Unexpected origin", 403);
    }
    if (c.req.path !== "/api/login") {
      const session = getCookie(c, "workbench");
      const expires = session && authState.sessions.get(session);
      if (!expires || expires <= Date.now())
        return c.text("Authentication required", 401);
    }
    if (terminalState.deletingSession && c.req.method !== "GET")
      return c.text("Session deletion in progress", 409);
    await next();
  });

  registerLogin(app, {
    authState,
    secureCookie: allowed.protocol === "https:",
  });
  registerGetSession(app, { terminalState });
  registerGetWorkspace(app, { workspace });
  registerUpdateSessions(app, {
    workspace,
    terminalState,
    tmux,
    workspaceDir: config.workspaceDir,
  });
  registerUpdateLayout(app, { workspace, terminalState });
  registerCreateTerminal(app, { workspace, terminalState });
  registerTerminal(app, { workspace, terminalState, tmux });
  registerRecreateTerminal(app, { workspace, terminalState, tmux });
  registerTerminalWebSocket(app, {
    workspace,
    terminalState,
    authState,
    tmux,
    tmuxConfig,
    workspaceDir: config.workspaceDir,
    shell: config.shell,
  });

  app.use("/*", serveStatic({ root: config.webRoot }));
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  const server = serve({
    fetch: app.fetch,
    hostname: config.hostname,
    port: config.port,
    websocket: { server: wss },
  });
  return {
    server,
    close: async () => {
      for (const detach of terminalState.controllers.values()) detach();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      wss.close();
    },
  };
}
