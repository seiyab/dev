import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
} from "@workbench/protocol";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

function TerminalPane({ onAuthRequired }: { onAuthRequired: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting");
  const [attempt, setAttempt] = useState(0);
  const [connected, setConnected] = useState(false);
  const disconnect = useRef<() => void>(() => {});

  useEffect(() => {
    if (!host.current) return;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | undefined;
    let manuallyDetached = false;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      theme: {
        background: "#10151b",
        foreground: "#dce6ef",
        cursor: "#80d5b0",
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
      fit.fit();
      send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    const input = terminal.onData((data) => {
      // Chunk large pastes to stay within the protocol's per-message limit.
      for (let i = 0; i < data.length; i += 4096)
        send({ type: "input", data: data.slice(i, i + 4096) });
    });
    async function connect() {
      const response = await fetch("/api/session");
      if (disposed) return;
      if (response.status === 401) {
        onAuthRequired();
        return;
      }
      if (!response.ok) throw new Error("Session check failed");
      const session = await response.json();
      if (session.active) {
        setStatus(
          "Terminal is controlled by another connection. Disconnect it before reconnecting here.",
        );
        return;
      }
      ws = new WebSocket(
        `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?v=${PROTOCOL_VERSION}`,
      );
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === "ready") {
          terminal.reset();
          setConnected(true);
          setStatus("Connected");
          resize();
          terminal.focus();
        } else if (message.type === "output") {
          terminal.write(message.data, () =>
            send({
              type: "ack",
              bytes: new TextEncoder().encode(message.data).length,
            }),
          );
        } else if (message.type === "error") setStatus(message.message);
        else if (message.type === "exit") {
          manuallyDetached = true;
          setStatus(
            `Terminal exited (${message.code}). Reconnect to start a shell.`,
          );
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
      if (disposed) return;
      setConnected(false);
      setStatus("Bridge unavailable. Retrying…");
      retry = setTimeout(() => {
        void connect().catch(failed);
      }, 2000);
    }
    disconnect.current = () => {
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
      terminal.dispose();
    };
  }, [attempt]);

  return (
    <>
      <div class="terminal-bar">
        <span id="terminal-title">Terminal / workspace</span>
        <button
          onClick={() =>
            connected ? disconnect.current() : setAttempt(attempt + 1)
          }
        >
          {connected ? "Disconnect" : "Reconnect"}
        </button>
      </div>
      <div
        class="terminal-host"
        ref={host}
        role="region"
        aria-labelledby="terminal-title"
      />
      <footer>
        <span class={connected ? "indicator online" : "indicator"} />
        <span role="status">{status}</span>
      </footer>
    </>
  );
}

function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch("/api/session")
      .then((r) => setAuthenticated(r.ok))
      .catch(() => {
        setAuthenticated(false);
        setError("Bridge unavailable");
      });
  }, []);
  async function login(event: SubmitEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!response.ok) {
        setError(await response.text());
        return;
      }
      setKey("");
      setAuthenticated(true);
    } catch {
      setError("Bridge unavailable");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main>
      <header>
        <div class="brand">
          Workbench<span class="badge">LOCAL</span>
        </div>
        <span class="subtitle">Development terminal</span>
      </header>
      {authenticated === null ? (
        <section class="login">
          <p>Connecting to your workspace…</p>
        </section>
      ) : authenticated ? (
        <TerminalPane onAuthRequired={() => setAuthenticated(false)} />
      ) : (
        <section class="login">
          <form onSubmit={login}>
            <p class="eyebrow">YOUR WORKSPACE</p>
            <h1>Pick up where you left off.</h1>
            <p>
              Enter the access key from your local bridge to open the terminal.
            </p>
            <label for="access-key">Access key</label>
            <input
              id="access-key"
              type="password"
              autoComplete="off"
              required
              value={key}
              onInput={(event) => setKey(event.currentTarget.value)}
            />
            <button disabled={busy}>
              {busy ? "Connecting…" : "Open terminal"}
            </button>
            {error && <p role="alert">{error}</p>}
          </form>
        </section>
      )}
    </main>
  );
}

render(<App />, document.getElementById("app")!);
