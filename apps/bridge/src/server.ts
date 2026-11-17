import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serve, upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { bodyLimit } from "hono/body-limit";
import * as pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
  parseLayout,
  MAX_TERMINALS,
  paneIds,
} from "@workbench/protocol";
import { workspaceStore } from "./workspace.js";

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
  const sessions = new Map<string, number>();
  const sessionTtl = 12 * 60 * 60 * 1000;
  let loginAttempts: number[] = [];
  const workspace = workspaceStore(config.stateDir);
  const controllers = new Map<string, () => void>();
  const deleting = new Set<string>();
  const run = promisify(execFile);
  async function running(id: string) {
    try {
      await run("tmux", [
        "-L",
        config.tmuxSocket,
        "has-session",
        "-t",
        `=${id}`,
      ]);
      return true;
    } catch {
      return false;
    }
  }
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
      const expires = session && sessions.get(session);
      if (!expires || expires <= Date.now())
        return c.text("Authentication required", 401);
    }
    await next();
  });
  app.post("/api/login", bodyLimit({ maxSize: 1024 }), async (c) => {
    loginAttempts = loginAttempts.filter((at) => at > Date.now() - 60_000);
    if (loginAttempts.length >= 10)
      return c.text("Too many attempts; wait one minute", 429);
    loginAttempts.push(Date.now());
    let key: unknown;
    try {
      key = (await c.req.json()).key;
    } catch {
      return c.text("Invalid request", 400);
    }
    if (
      typeof key !== "string" ||
      Buffer.byteLength(key) !== Buffer.byteLength(accessKey) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(accessKey))
    )
      return c.text("Invalid access key", 401);
    for (const [id, expiry] of sessions)
      if (expiry <= Date.now()) sessions.delete(id);
    if (sessions.size >= 32) sessions.delete(sessions.keys().next().value!);
    const id = randomBytes(32).toString("hex");
    sessions.set(id, Date.now() + sessionTtl);
    setCookie(c, "workbench", id, {
      httpOnly: true,
      sameSite: "Strict",
      secure: allowed.protocol === "https:",
      path: "/",
      maxAge: sessionTtl / 1000,
    });
    return c.json({ ok: true });
  });
  app.get("/api/session", (c) =>
    c.json({ version: PROTOCOL_VERSION, active: controllers.has("terminal") }),
  );
  app.get("/api/workspace", (c) => c.json(workspace.get()));
  app.put("/api/layout", bodyLimit({ maxSize: 32 * 1024 }), async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.text("Invalid request", 400);
    }
    if (!body || body.revision !== workspace.get().revision)
      return c.text(
        "Workspace changed in another client. Reload to continue.",
        409,
      );
    const layout = parseLayout(body.layout, workspace.get().terminals);
    if (!layout) return c.text("Invalid layout", 400);
    if (paneIds(layout.root).some((id) => deleting.has(id)))
      return c.text("Terminal is being terminated", 409);
    return c.json(workspace.update({ ...workspace.get(), layout }));
  });
  app.post("/api/terminals", (c) => {
    const state = workspace.get();
    if (state.terminals.length >= MAX_TERMINALS)
      return c.text(
        "Terminal limit reached. Terminate a detached terminal first.",
        409,
      );
    const resource = {
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
  app.get("/api/terminals/:id", async (c) => {
    const resource = workspace
      .get()
      .terminals.find((t) => t.id === c.req.param("id"));
    if (!resource) return c.text("Unknown terminal", 404);
    return c.json({
      ...resource,
      active: controllers.has(resource.id),
      running: await running(resource.id),
    });
  });
  app.post("/api/terminals/:id/recreate", async (c) => {
    const resource = workspace
      .get()
      .terminals.find((t) => t.id === c.req.param("id"));
    if (!resource) return c.text("Unknown terminal", 404);
    if (
      deleting.has(resource.id) ||
      (await running(resource.id)) ||
      controllers.has(resource.id)
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
  app.delete("/api/terminals/:id", async (c) => {
    const id = c.req.param("id");
    if (deleting.has(id)) return c.text("Terminal is being terminated", 409);
    const state = workspace.get();
    if (!state.terminals.some((t) => t.id === id))
      return c.text("Unknown terminal", 404);
    if (controllers.has(id))
      return c.text("Disconnect the terminal before terminating it", 409);
    // This also prevents an old client from killing a currently visible resource.
    const remaining = state.terminals.filter((t) => t.id !== id);
    if (!parseLayout(state.layout, remaining))
      return c.text("Close the pane before terminating its terminal", 409);
    deleting.add(id);
    try {
      try {
        await run("tmux", [
          "-L",
          config.tmuxSocket,
          "kill-session",
          "-t",
          `=${id}`,
        ]);
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
      deleting.delete(id);
    }
  });
  app.get(
    "/api/terminal",
    async (c, next) => {
      if (c.req.query("v") !== String(PROTOCOL_VERSION))
        return c.text("Unsupported protocol", 400);
      const id = c.req.query("id") ?? "terminal";
      const resource = workspace.get().terminals.find((t) => t.id === id);
      if (!resource) return c.text("Unknown terminal", 404);
      if (deleting.has(id)) return c.text("Terminal is being terminated", 409);
      if (controllers.has(id))
        return c.text("Terminal already controlled by another connection", 409);
      if (resource.started && !(await running(id)))
        return c.text(
          "Terminal ended. Recreate it explicitly to start a new shell.",
          410,
        );
      return next();
    },
    upgradeWebSocket((c) => {
      const authenticationExpiry = sessions.get(getCookie(c, "workbench")!)!;
      const id = c.req.query("id") ?? "terminal";
      let terminal: pty.IPty | undefined;
      let socket: WebSocket | undefined;
      let pending = 0;
      let paused = false;
      let timer: ReturnType<typeof setInterval> | undefined;
      let expiry: ReturnType<typeof setTimeout> | undefined;
      let disposed = false;
      function cleanup() {
        if (disposed) return;
        disposed = true;
        clearInterval(timer);
        clearTimeout(expiry);
        terminal?.kill();
        if (socket) {
          controllers.delete(id);
        }
      }
      function send(message: ServerMessage) {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify(message));
      }
      return {
        onOpen(_event, ws) {
          socket = ws.raw as WebSocket;
          if (
            controllers.has(id) ||
            deleting.has(id) ||
            !workspace.get().terminals.some((t) => t.id === id)
          ) {
            socket.close(1008, "Already controlled");
            socket = undefined;
            return;
          }
          controllers.set(id, () => {
            socket?.terminate();
            cleanup();
          });
          // Do not pass the bridge's configuration or authentication environment into shells.
          const env: Record<string, string> = {};
          for (const name of [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "LANG",
            "LC_ALL",
            "TZ",
          ]) {
            if (process.env[name]) env[name] = process.env[name]!;
          }
          env.TERM = "xterm-256color";
          try {
            terminal = pty.spawn(
              "tmux",
              [
                "-L",
                config.tmuxSocket,
                "-f",
                tmuxConfig,
                ...(workspace.get().terminals.find((t) => t.id === id)?.started
                  ? ["attach-session", "-t", `=${id}`]
                  : [
                      "new-session",
                      "-A",
                      "-s",
                      id,
                      "-c",
                      config.workspaceDir,
                      config.shell,
                    ]),
              ],
              {
                name: "xterm-256color",
                cols: 80,
                rows: 24,
                cwd: config.workspaceDir,
                env,
              },
            );
            const state = workspace.get();
            if (!state.terminals.find((t) => t.id === id)?.started)
              workspace.update(
                {
                  ...state,
                  terminals: state.terminals.map((t) =>
                    t.id === id ? { ...t, started: true } : t,
                  ),
                },
                false,
              );
            terminal.onData((data) => {
              if (disposed || socket?.readyState !== WebSocket.OPEN) return;
              pending += Buffer.byteLength(data);
              send({ type: "output", data });
              if (pending >= 128 * 1024 && !paused) {
                terminal?.pause();
                paused = true;
              }
              if (
                pending > 1024 * 1024 ||
                socket.bufferedAmount > 1024 * 1024
              ) {
                socket.close(1008, "Output consumer too slow");
                cleanup();
              }
            });
            terminal.onExit(({ exitCode }) => {
              send({ type: "exit", code: exitCode });
              socket?.close(1000, "Terminal detached");
              cleanup();
            });
            // Bound connection lifetime and detect clients that vanished without closing.
            expiry = setTimeout(
              () => {
                socket?.close(1008, "Please reconnect");
                cleanup();
              },
              Math.max(0, authenticationExpiry - Date.now()),
            );
            let alive = true;
            socket.on("pong", () => {
              alive = true;
            });
            timer = setInterval(() => {
              if (!alive) {
                socket?.terminate();
                cleanup();
                return;
              }
              alive = false;
              socket?.ping();
            }, 30_000);
            send({ type: "ready", version: PROTOCOL_VERSION });
          } catch {
            send({ type: "error", message: "Could not start terminal" });
            socket.close(1011, "Terminal startup failed");
            cleanup();
          }
        },
        onMessage(event) {
          if (disposed || !terminal || typeof event.data !== "string") {
            socket?.close(1008, "Invalid message");
            return;
          }
          const message = parseClientMessage(event.data);
          if (!message) {
            socket?.close(1008, "Invalid message");
            cleanup();
            return;
          }
          if (message.type === "input") terminal.write(message.data);
          else if (message.type === "resize")
            terminal.resize(message.cols, message.rows);
          else {
            if (message.bytes > pending) {
              socket?.close(1008, "Invalid acknowledgement");
              cleanup();
              return;
            }
            pending -= message.bytes;
            if (paused && pending < 32 * 1024) {
              terminal.resume();
              paused = false;
            }
          }
        },
        onClose: cleanup,
        onError: cleanup,
      };
    }),
  );
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
      for (const detach of controllers.values()) detach();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      wss.close();
    },
  };
}
