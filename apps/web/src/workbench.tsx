import { useEffect, useRef, useState } from "preact/hooks";
import {
  MAX_PANES,
  paneIds,
  parseLayout,
  type Direction,
  type Layout,
  type TerminalResource,
  type WorkspaceState,
} from "@workbench/protocol";
import { TerminalPane, type TerminalHandle } from "./terminal-pane.js";
import {
  neighbor,
  placements,
  replace,
  resizePane,
  split,
  type Rect,
} from "./layout.js";

interface Command {
  id: string;
  label: string;
  key: string;
  run: () => void;
}
type DialogKind = "commands" | "terminals";
function Picker({
  kind,
  commands,
  detached,
  close,
  reopen,
  terminate,
  notice,
}: {
  kind: DialogKind;
  commands: Command[];
  detached: TerminalResource[];
  close: () => void;
  reopen: (id: string) => void;
  terminate: (id: string) => void;
  notice: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-labelledby="picker-title"
    >
      <div class="dialog-heading">
        <h2 id="picker-title">
          {kind === "commands" ? "Workbench commands" : "Detached terminals"}
        </h2>
        <button onClick={close} aria-label="Close dialog">
          ×
        </button>
      </div>
      <input
        aria-label="Filter"
        placeholder="Filter…"
        value={query}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <div class="picker-items">
        {notice && <p role="alert">{notice}</p>}
        {kind === "commands"
          ? commands
              .filter((c) =>
                c.label.toLowerCase().includes(query.toLowerCase()),
              )
              .map((command) => (
                <button
                  class="command-item"
                  onClick={() => {
                    close();
                    command.run();
                  }}
                  key={command.id}
                >
                  <span>{command.label}</span>
                  <kbd>Ctrl-g {command.key}</kbd>
                </button>
              ))
          : detached
              .filter((t) =>
                t.title.toLowerCase().includes(query.toLowerCase()),
              )
              .map((terminal) => (
                <div class="detached-item" key={terminal.id}>
                  <button
                    class="command-item"
                    onClick={() => reopen(terminal.id)}
                  >
                    <span>Reopen {terminal.title}</span>
                    <span class="muted">{terminal.id.slice(0, 8)}</span>
                  </button>
                  <button
                    onClick={() => terminate(terminal.id)}
                    aria-label={`Terminate ${terminal.title}`}
                  >
                    Terminate
                  </button>
                </div>
              ))}
        {kind === "terminals" && detached.length === 0 && (
          <p>No detached terminals. Closing a pane keeps its terminal here.</p>
        )}
      </div>
    </dialog>
  );
}

export function Workbench({ onAuthRequired }: { onAuthRequired: () => void }) {
  const [layout, setLayout] = useState<Layout | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const [resources, setResources] = useState<TerminalResource[]>([]);
  const resourcesRef = useRef<TerminalResource[]>([]);
  const revision = useRef(0);
  const queue = useRef(Promise.resolve());
  const blocked = useRef(false);
  const busy = useRef(false);
  const handles = useRef(new Map<string, TerminalHandle>());
  const [mode, setMode] = useState<"normal" | "prefix" | "resize">("normal");
  const modeRef = useRef(mode);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(0);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const alive = useRef(true);

  function changeMode(next: typeof mode) {
    if (next === "prefix" && !blocked.current) setNotice("");
    modeRef.current = next;
    setMode(next);
  }
  async function api(path: string, options?: RequestInit) {
    const response = await fetch(path, options);
    if (response.status === 401) {
      onAuthRequired();
      throw new Error("Authentication expired");
    }
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  function updateResources(next: TerminalResource[]) {
    resourcesRef.current = next;
    setResources(next);
  }
  useEffect(() => {
    alive.current = true;
    void api("/api/workspace")
      .then((state: WorkspaceState) => {
        if (!alive.current) return;
        revision.current = state.revision;
        updateResources(state.terminals);
        layoutRef.current = state.layout;
        setLayout(state.layout);
      })
      .catch((error: Error) => setNotice(error.message));
    return () => {
      alive.current = false;
    };
  }, []);

  function commit(next: Layout) {
    if (blocked.current || !parseLayout(next, resourcesRef.current)) return;
    layoutRef.current = next;
    setLayout(next);
    setNotice("");
    setPending((n) => n + 1);
    queue.current = queue.current
      .then(async () => {
        if (blocked.current) return;
        const state: WorkspaceState = await api("/api/layout", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revision: revision.current, layout: next }),
          keepalive: true,
        });
        revision.current = state.revision;
      })
      .catch((error: Error) => {
        blocked.current = true;
        setNotice(
          `Layout not saved: ${error.message} Reload before making more layout changes.`,
        );
      })
      .finally(() => {
        if (alive.current) setPending((n) => n - 1);
      });
  }
  function focus(id: string) {
    const current = layoutRef.current;
    if (current && id !== current.activeId) {
      const next = {
        ...current,
        activeId: id,
        zoomedId: current.zoomedId ? id : null,
      };
      if (blocked.current) {
        layoutRef.current = next;
        setLayout(next);
      } else commit(next);
    }
  }
  function focusTerminal() {
    const id = layoutRef.current?.activeId;
    if (id) handles.current.get(id)?.focus();
  }
  function closeDialog() {
    setDialog(null);
    requestAnimationFrame(focusTerminal);
  }
  function openPicker(kind: DialogKind) {
    if (!blocked.current) setNotice("");
    setDialog(kind);
    changeMode("normal");
    if (kind === "terminals")
      void api("/api/workspace")
        .then((state: WorkspaceState) => updateResources(state.terminals))
        .catch((error: Error) => setNotice(error.message));
  }
  function insert(id: string, axis: "x" | "y") {
    const current = layoutRef.current;
    if (
      !current ||
      paneIds(current.root).length >= MAX_PANES ||
      blocked.current
    )
      return;
    const next = {
      root: split(current.root, current.activeId, id, axis),
      activeId: id,
      zoomedId: null,
    };
    if (!parseLayout(next, resourcesRef.current)) {
      setNotice(
        "Layout nesting limit reached. The terminal is available in the detached picker.",
      );
      return;
    }
    commit(next);
  }
  async function newPane(axis: "x" | "y") {
    const current = layoutRef.current;
    if (!current || busy.current || blocked.current) return;
    if (paneIds(current.root).length >= MAX_PANES) {
      setNotice(`A layout supports up to ${MAX_PANES} panes.`);
      return;
    }
    busy.current = true;
    try {
      const terminal: TerminalResource = await api("/api/terminals", {
        method: "POST",
      });
      updateResources([...resourcesRef.current, terminal]);
      insert(terminal.id, axis);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      busy.current = false;
    }
  }
  function closePane(id: string) {
    const current = layoutRef.current;
    if (!current) return;
    const root = replace(current.root, id, null);
    const ids = paneIds(root);
    const activeId = ids.includes(current.activeId!)
      ? current.activeId
      : (ids[0] ?? null);
    commit({
      root,
      activeId,
      zoomedId: current.zoomedId === id ? null : current.zoomedId,
    });
  }
  async function terminate(id: string) {
    try {
      await queue.current;
      const state: WorkspaceState = await api(`/api/terminals/${id}`, {
        method: "DELETE",
      });
      updateResources(state.terminals);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }
  function move(direction: Direction) {
    const current = layoutRef.current;
    if (!current?.activeId) return;
    const id = neighbor(current.root, current.activeId, direction);
    if (id) {
      focus(id);
      requestAnimationFrame(() => handles.current.get(id)?.focus());
    }
  }
  function resize(direction: Direction) {
    const current = layoutRef.current;
    if (!current?.activeId) return;
    const root = resizePane(current.root, current.activeId, direction);
    if (root !== current.root) commit({ ...current, root });
  }
  function zoom() {
    const current = layoutRef.current;
    if (current?.activeId) {
      commit({
        ...current,
        zoomedId: current.zoomedId ? null : current.activeId,
      });
    }
  }
  const commands: Command[] = [
    {
      id: "split-x",
      label: "Split left / right",
      key: "%",
      run: () => {
        void newPane("x");
      },
    },
    {
      id: "split-y",
      label: "Split top / bottom",
      key: '"',
      run: () => {
        void newPane("y");
      },
    },
    ...(["h", "j", "k", "l"] as Direction[]).map((direction) => ({
      id: `focus-${direction}`,
      label: `Focus ${{ h: "left", j: "down", k: "up", l: "right" }[direction]}`,
      key: direction,
      run: () => move(direction),
    })),
    ...(["h", "j", "k", "l"] as Direction[]).map((direction) => ({
      id: `resize-${direction}`,
      label: `Resize ${{ h: "left", j: "down", k: "up", l: "right" }[direction]}`,
      key: direction.toUpperCase(),
      run: () => {
        resize(direction);
        changeMode("resize");
      },
    })),
    { id: "zoom", label: "Toggle pane zoom", key: "z", run: zoom },
    {
      id: "close",
      label: "Close pane (keep terminal)",
      key: "x",
      run: () => {
        const id = layoutRef.current?.activeId;
        if (id) closePane(id);
      },
    },
    {
      id: "terminals",
      label: "Reopen detached terminal",
      key: "d",
      run: () => openPicker("terminals"),
    },
    {
      id: "commands",
      label: "Command palette / binding help",
      key: "p / ?",
      run: () => openPicker("commands"),
    },
    {
      id: "literal",
      label: "Send literal Ctrl-g",
      key: "Ctrl-g",
      run: () => {
        const id = layoutRef.current?.activeId;
        if (id) handles.current.get(id)?.literalPrefix();
      },
    },
  ];
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.isComposing || dialogRef.current) return;
      const prefix =
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === "g";
      if (modeRef.current === "normal" && !prefix) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (prefix) {
        if (event.repeat) return;
        if (modeRef.current === "prefix") {
          changeMode("normal");
          commandsRef.current.find((c) => c.id === "literal")?.run();
        } else changeMode("prefix");
        return;
      }
      if (event.key === "Escape") {
        changeMode("normal");
        return;
      }
      // Shift and other modifier events precede printable bindings such as % and ".
      if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      if (
        modeRef.current === "resize" &&
        /^[hjkl]$/i.test(event.key) &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        resizeRef.current(event.key.toLowerCase() as Direction);
        return;
      }
      const command = commandsRef.current.find(
        (c) =>
          c.key === event.key ||
          (c.id === "commands" && (event.key === "p" || event.key === "?")),
      );
      changeMode("normal");
      if (command && !event.ctrlKey && !event.altKey && !event.metaKey)
        command.run();
      else setNotice("Unknown workbench command. Ctrl-g ? shows bindings.");
    }
    const clear = () => changeMode("normal");
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const resizeRef = useRef(resize);
  resizeRef.current = resize;

  const positions = placements(layout?.root ?? null);
  function paneStyle(rect: Rect) {
    return {
      left: `calc(${rect.x * 100}% + 3px)`,
      top: `calc(${rect.y * 100}% + 3px)`,
      width: `calc(${rect.width * 100}% - 6px)`,
      height: `calc(${rect.height * 100}% - 6px)`,
    };
  }
  return (
    <>
      <div class="workbench-toolbar">
        <span>
          Workspace <span class="muted">/ implementation</span>
        </span>
        <div class="toolbar-actions">
          <button
            onClick={() => commands.find((c) => c.id === "split-x")?.run()}
          >
            Split ↔
          </button>
          <button
            onClick={() => commands.find((c) => c.id === "split-y")?.run()}
          >
            Split ↕
          </button>
          <button
            onClick={() => commands.find((c) => c.id === "terminals")?.run()}
          >
            Detached terminals
          </button>
          <button
            onClick={() => commands.find((c) => c.id === "commands")?.run()}
          >
            Commands <kbd>Ctrl-g</kbd>
          </button>
        </div>
      </div>
      <div class="pane-canvas">
        {positions
          .filter((p) => p.node.type === "terminal")
          .map(({ node, rect }) => {
            const hidden = !!layout?.zoomedId && layout.zoomedId !== node.id;
            return (
              <section
                key={node.id}
                data-pane-id={node.id}
                aria-label={resources.find((t) => t.id === node.id)?.title}
                class={`pane ${layout?.activeId === node.id ? "active-pane" : ""}`}
                style={{
                  ...paneStyle(
                    layout?.zoomedId === node.id
                      ? { x: 0, y: 0, width: 1, height: 1 }
                      : rect,
                  ),
                  display: hidden ? "none" : undefined,
                }}
              >
                <TerminalPane
                  id={node.id}
                  title={
                    resources.find((t) => t.id === node.id)?.title ?? "Terminal"
                  }
                  active={layout?.activeId === node.id && !dialog}
                  onFocus={() => focus(node.id)}
                  onClose={() => closePane(node.id)}
                  onAuthRequired={onAuthRequired}
                  register={(id, handle) => {
                    if (handle) handles.current.set(id, handle);
                    else handles.current.delete(id);
                  }}
                />
              </section>
            );
          })}
        {!layout ? (
          <p class="empty-workspace">Loading workspace… {notice}</p>
        ) : (
          !layout.root && (
            <div class="empty-workspace">
              <h2>Your terminals are still here.</h2>
              <p>Reopen a detached terminal or start a new one.</p>
              <button onClick={() => openPicker("terminals")}>
                Detached terminals
              </button>{" "}
              <button
                onClick={() => {
                  void newPane("x");
                }}
              >
                New terminal
              </button>
            </div>
          )
        )}
      </div>
      <div
        class="workbench-status"
        data-layout-status
        role="status"
        aria-live="polite"
      >
        {notice ||
          (mode === "prefix"
            ? 'Ctrl-g → % split ↔ · " split ↕ · h/j/k/l focus · H/J/K/L resize · z zoom · x close · d detached · ? help · Esc cancel'
            : mode === "resize"
              ? "Resize mode · h/j/k/l move boundary · Escape finishes"
              : pending
                ? "Saving layout…"
                : layout?.zoomedId
                  ? "Layout saved · Zoomed · Ctrl-g z to restore"
                  : "Layout saved · Ctrl-g ? for commands")}
      </div>
      {dialog && (
        <Picker
          kind={dialog}
          commands={commands}
          detached={resources.filter(
            (t) => !paneIds(layout?.root ?? null).includes(t.id),
          )}
          close={closeDialog}
          reopen={(id) => {
            closeDialog();
            insert(id, "x");
          }}
          terminate={(id) => {
            void terminate(id);
          }}
          notice={notice}
        />
      )}
    </>
  );
}
