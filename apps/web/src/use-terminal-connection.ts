import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@workbench/protocol";

export interface TerminalHandle {
  focus: () => void;
  literalPrefix: () => void;
}

/** Owns the browser terminal and its attachment; disposal leaves the backend tmux session alive. */
export function useTerminalConnection({
  id,
  active,
  onAuthRequired,
  onExit,
}: {
  id: string;
  active: boolean;
  onAuthRequired: () => void;
  onExit: () => void;
}) {
  // Parent callbacks and focus can change without recreating the browser connection.
  const latest = useRef({ active, onAuthRequired, onExit });
  latest.current = { active, onAuthRequired, onExit };
  const handle = useRef<TerminalHandle | null>(null);
  const [ended, setEnded] = useState(false);
  useEffect(() => {
    if (active) handle.current?.focus();
  }, [active]);
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting");
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const disconnectRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | undefined;
    let manuallyDetached = false;
    // xterm draws its own colors, so pass the resolved CSS palette.
    const styles = getComputedStyle(host.current);
    const color = (token: string) => styles.getPropertyValue(token).trim();
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      minimumContrastRatio: 4.5,
      theme: {
        background: color("--terminal-background"),
        foreground: color("--terminal-foreground"),
        cursor: color("--terminal-cursor"),
        cursorAccent: color("--terminal-background"),
        selectionBackground: color("--terminal-selection"),
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const send = (message: ClientMessage) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    const resize = () => {
      if (!host.current?.clientWidth || !host.current.clientHeight) return;
      fit.fit();
      terminal.resize(
        Math.min(500, Math.max(2, terminal.cols)),
        Math.min(300, Math.max(1, terminal.rows)),
      );
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = terminal.onData((data) => {
      // Chunk large pastes to stay within the protocol's per-message limit.
      for (let i = 0; i < data.length; i += 4096)
        send({ type: "input", data: data.slice(i, i + 4096) });
    });
    handle.current = {
      focus: () => terminal.focus(),
      literalPrefix: () => send({ type: "input", data: "\x07" }),
    };
    async function connect(wait = 0) {
      if (disposed || manuallyDetached) return;
      const response = await fetch(`/api/terminals/${id}`);
      if (disposed || manuallyDetached) return;
      if (response.status === 401) {
        latest.current.onAuthRequired();
        return;
      }
      if (!response.ok) throw new Error("Session check failed");
      const session = await response.json();
      if (disposed || manuallyDetached) return;
      if (session.active) {
        if (wait < 5) {
          retry = setTimeout(() => {
            void connect(wait + 1).catch(failed);
          }, 200);
          return;
        }
        setStatus(
          "Terminal is controlled by another connection. Disconnect it before reconnecting here.",
        );
        return;
      }
      if (session.started && !session.running) {
        setEnded(true);
        setStatus("Terminal ended. Recreate it to start a new shell.");
        latest.current.onExit();
        return;
      }
      setEnded(false);
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?v=${PROTOCOL_VERSION}&id=${id}`,
      );
      const connection = ws;
      ws.onmessage = (event) => {
        if (disposed) return;
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === "ready") {
          terminal.reset();
          setConnected(true);
          setStatus("Connected");
          resize();
          if (latest.current.active) terminal.focus();
        } else if (message.type === "output") {
          terminal.write(message.data, () => {
            if (connection.readyState === WebSocket.OPEN)
              connection.send(
                JSON.stringify({
                  type: "ack",
                  bytes: new TextEncoder().encode(message.data).length,
                }),
              );
          });
        } else if (message.type === "error") setStatus(message.message);
        else if (message.type === "exit") {
          manuallyDetached = true;
          setEnded(true);
          setStatus(
            `Terminal exited (${message.code}). Recreate it to start a shell.`,
          );
          latest.current.onExit();
        }
      };
      ws.onclose = (event) => {
        setConnected(false);
        if (disposed || manuallyDetached) return;
        if (event.code === 1008 || event.code === 1011) {
          setStatus(`Disconnected: ${event.reason}. Reconnect when ready.`);
          return;
        }
        setStatus("Connection lost. Reconnecting…");
        retry = setTimeout(() => {
          void connect().catch(failed);
        }, 1500);
      };
      ws.onerror = () => setStatus("Connection unavailable");
    }
    function failed() {
      if (disposed || manuallyDetached) return;
      setConnected(false);
      setStatus("Bridge unavailable. Retrying…");
      retry = setTimeout(() => {
        void connect().catch(failed);
      }, 2000);
    }
    disconnectRef.current = () => {
      manuallyDetached = true;
      clearTimeout(retry);
      ws?.close();
      setConnected(false);
      setStatus("Detached. Your shell is still running.");
    };
    setStatus("Connecting");
    void connect().catch(failed);
    return () => {
      disposed = true;
      clearTimeout(retry);
      observer.disconnect();
      input.dispose();
      ws?.close();
      handle.current = null;
      disconnectRef.current = () => {};
      terminal.dispose();
    };
  }, [id, attempt]);

  // Keep the registered handle valid across explicit reconnects.
  const terminalHandle = useMemo<TerminalHandle>(
    () => ({
      focus: () => handle.current?.focus(),
      literalPrefix: () => handle.current?.literalPrefix(),
    }),
    [],
  );
  function reconnect() {
    setAttempt((value) => value + 1);
  }
  async function recreate() {
    const connection = handle.current;
    try {
      const response = await fetch(`/api/terminals/${id}/recreate`, {
        method: "POST",
      });
      // Ignore requests completed after this attachment has been replaced or disposed.
      if (handle.current !== connection) return;
      if (response.status === 401) {
        latest.current.onAuthRequired();
        return;
      }
      if (!response.ok) {
        const message = await response.text();
        if (handle.current === connection) setStatus(message);
        return;
      }
      setEnded(false);
      reconnect();
    } catch {
      if (handle.current === connection) setStatus("Bridge unavailable");
    }
  }
  return {
    host,
    status,
    connected,
    ended,
    handle: terminalHandle,
    disconnect: () => disconnectRef.current(),
    reconnect,
    recreate,
  };
}
