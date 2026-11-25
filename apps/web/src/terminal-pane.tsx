import styles from "./terminal-pane.module.css";
import "@xterm/xterm/css/xterm.css";
import { useEffect } from "preact/hooks";
import {
  useTerminalConnection,
  type TerminalHandle,
} from "./use-terminal-connection.js";

export type { TerminalHandle } from "./use-terminal-connection.js";
interface TerminalPaneProps {
  id: string;
  title: string;
  active: boolean;
  onFocus: () => void;
  onClose: () => void;
  onAuthRequired: () => void;
  register: (handle: TerminalHandle | null) => void;
}

export function TerminalPane(props: TerminalPaneProps) {
  return <TerminalPaneInstance key={props.id} {...props} />;
}

function TerminalPaneInstance({
  id,
  title,
  active,
  onFocus,
  onClose,
  onAuthRequired,
  register,
}: TerminalPaneProps) {
  const {
    host,
    status,
    connected,
    ended,
    handle,
    disconnect,
    reconnect,
    recreate,
  } = useTerminalConnection({ id, active, onAuthRequired, onExit: onClose });
  useEffect(() => {
    register(handle);
    return () => register(null);
  }, [handle, register]);

  return (
    <div class={styles.content} onPointerDown={onFocus} onFocusIn={onFocus}>
      <div class={styles.bar}>
        <span id={`title-${id}`}>{title}</span>
        <div class={styles.actions}>
          <button
            onClick={() => {
              if (ended) void recreate();
              else if (connected) disconnect();
              else reconnect();
            }}
          >
            {ended ? "Recreate" : connected ? "Disconnect" : "Reconnect"}
          </button>
          <button
            onClick={onClose}
            aria-label={`Close pane: ${title}`}
            title="Close pane and keep terminal running"
          >
            ×
          </button>
        </div>
      </div>
      <div class={styles.terminalArea}>
        <div
          class={styles.host}
          ref={host}
          role="region"
          aria-labelledby={`title-${id}`}
        />
      </div>
      <footer class={styles.footer}>
        <span class={`${styles.indicator} ${connected ? styles.online : ""}`} />
        <span role="status">{status}</span>
      </footer>
    </div>
  );
}
