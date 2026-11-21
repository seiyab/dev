import type { Hono } from "hono";
import { upgradeWebSocket } from "@hono/node-server";
import { getCookie } from "hono/cookie";
import * as pty from "node-pty";
import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  type ServerMessage,
} from "@workbench/protocol";
import type { workspaceStore } from "../../state/workspace.js";
import type { createTerminalState } from "../../state/terminals.js";
import type { createAuthState } from "../../state/auth.js";
import type { createTmux } from "../../tmux.js";

export function registerTerminalWebSocket(
  app: Hono,
  {
    workspace,
    terminalState,
    authState,
    tmux,
    tmuxConfig,
    workspaceDir,
    shell,
  }: {
    workspace: ReturnType<typeof workspaceStore>;
    terminalState: ReturnType<typeof createTerminalState>;
    authState: ReturnType<typeof createAuthState>;
    tmux: ReturnType<typeof createTmux>;
    tmuxConfig: string;
    workspaceDir: string;
    shell: string;
  },
) {
  app.get(
    "/api/terminal",
    async (c, next) => {
      if (c.req.query("v") !== String(PROTOCOL_VERSION))
        return c.text("Unsupported protocol", 400);
      const id = c.req.query("id") ?? "terminal";
      const resource = workspace.get().terminals.find((t) => t.id === id);
      if (!resource) return c.text("Unknown terminal", 404);
      if (terminalState.deletingSession || terminalState.deleting.has(id))
        return c.text("Terminal is being terminated", 409);
      if (terminalState.controllers.has(id))
        return c.text("Terminal already controlled by another connection", 409);
      if (resource.started && !(await tmux.running(id)))
        return c.text(
          "Terminal ended. Recreate it explicitly to start a new shell.",
          410,
        );
      return next();
    },
    upgradeWebSocket((c) => {
      const authenticationExpiry = authState.sessions.get(
        getCookie(c, "workbench")!,
      )!;
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
          terminalState.controllers.delete(id);
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
            terminalState.controllers.has(id) ||
            terminalState.deletingSession ||
            terminalState.deleting.has(id) ||
            !workspace.get().terminals.some((t) => t.id === id)
          ) {
            socket.close(1008, "Already controlled");
            socket = undefined;
            return;
          }
          terminalState.controllers.set(id, () => {
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
          const resource = workspace.get().terminals.find((t) => t.id === id);
          const directory =
            workspace.get().sessions.find((s) => s.id === resource?.sessionId)
              ?.directory ?? workspaceDir;
          try {
            terminal = pty.spawn(
              "tmux",
              [
                "-L",
                tmux.socket,
                "-f",
                tmuxConfig,
                ...(workspace.get().terminals.find((t) => t.id === id)?.started
                  ? ["attach-session", "-t", `=${id}`]
                  : ["new-session", "-A", "-s", id, "-c", directory, shell]),
              ],
              {
                name: "xterm-256color",
                cols: 80,
                rows: 24,
                cwd: directory,
                env,
              },
            );
            let ready = false;
            terminal.onData((data) => {
              if (disposed || socket?.readyState !== WebSocket.OPEN) return;
              // tmux's first redraw confirms attachment. Advertising readiness at
              // spawn can let an immediate session switch kill tmux before it starts.
              if (!ready) {
                ready = true;
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
                send({ type: "ready", version: PROTOCOL_VERSION });
              }
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
}
