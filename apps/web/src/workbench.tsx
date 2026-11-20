import { ecq } from "@seiyab/ecq";
import { useMutation, useQuery, useQueryClient } from "@tanstack/preact-query";
import {
  AuthenticationError,
  createTerminalMutationOptions,
  deleteTerminalMutationOptions,
  saveLayoutMutationOptions,
  workspaceQuery,
  sessionMutationOptions,
} from "./api.js";
import { SessionDialog, type SessionDialogMode } from "./session-dialog.js";
import styles from "./workbench.module.css";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "preact/hooks";
import {
  MAX_PANES,
  paneIds,
  parseLayout,
  type SessionAction,
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
type DialogKind = "commands" | "terminals" | SessionDialogMode;
function Picker({
  kind,
  commands,
  detached,
  close,
  reopen,
  terminate,
  notice,
}: {
  kind: "commands" | "terminals";
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
      class={styles.dialog}
      ref={dialog}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-labelledby="picker-title"
    >
      <div class={styles.dialogHeading}>
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
      <div class={styles.pickerItems}>
        {notice && <p role="alert">{notice}</p>}
        {kind === "commands"
          ? commands
              .filter((c) =>
                c.label.toLowerCase().includes(query.toLowerCase()),
              )
              .map((command) => (
                <button
                  class={styles.commandItem}
                  onClick={() => {
                    close();
                    command.run();
                  }}
                  key={command.id}
                >
                  <span>{command.label}</span>
                  {command.key && <kbd>Ctrl-g {command.key}</kbd>}
                </button>
              ))
          : detached
              .filter((t) =>
                t.title.toLowerCase().includes(query.toLowerCase()),
              )
              .map((terminal) => (
                <div class={styles.detachedItem} key={terminal.id}>
                  <button
                    class={styles.commandItem}
                    onClick={() => reopen(terminal.id)}
                  >
                    <span>Reopen {terminal.title}</span>
                    <span class={styles.muted}>{terminal.id.slice(0, 8)}</span>
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
  const workspace = useQuery(workspaceQuery());
  useEffect(() => {
    if (workspace.error instanceof AuthenticationError) onAuthRequired();
  }, [workspace.error, onAuthRequired]);
  if (!workspace.data) {
    return <p role="status">Loading workspace… {workspace.error?.message}</p>;
  }
  // Initialize the editable draft once; picker refreshes must not replace it.
  return (
    <LoadedWorkbench
      key={workspace.data.selectedSessionId ?? "no-session"}
      initialState={workspace.data}
      resources={workspace.data.terminals.filter(
        (t) => t.sessionId === workspace.data.selectedSessionId,
      )}
      onAuthRequired={onAuthRequired}
    />
  );
}

function LoadedWorkbench({
  initialState,
  resources,
  onAuthRequired,
}: {
  initialState: WorkspaceState;
  resources: TerminalResource[];
  onAuthRequired: () => void;
}) {
  const queryClient = useQueryClient();
  const [layout, setLayout] = useState<Layout | null>(initialState.layout);
  const layoutRef = useRef<Layout | null>(initialState.layout);
  const revision = useRef(initialState.revision);
  const queue = useRef(Promise.resolve());
  const blocked = useRef(false);
  const busy = useRef(false);
  const changingSession = useRef(false);
  const handles = useRef(new Map<string, TerminalHandle>());
  const [mode, setMode] = useState<"normal" | "prefix" | "resize">("normal");
  const modeRef = useRef(mode);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(0);
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;
  const alive = useRef(true);

  const changeMode = useCallback((next: typeof mode) => {
    if (next === "prefix" && !blocked.current) setNotice("");
    modeRef.current = next;
    setMode(next);
  }, []);
  function onMutationError(error: Error) {
    if (error instanceof AuthenticationError) onAuthRequired();
  }
  function currentResources() {
    // Mutation continuations can run before the query observer rerenders.
    return (
      queryClient
        .getQueryData<WorkspaceState>(workspaceQuery().queryKey)
        ?.terminals.filter(
          (t) => t.sessionId === initialState.selectedSessionId,
        ) ?? []
    );
  }
  const saveLayout = useMutation({
    ...saveLayoutMutationOptions,
    onError: onMutationError,
  });
  const createTerminal = useMutation({
    ...createTerminalMutationOptions,
    onError: onMutationError,
  });
  const mutateSession = useMutation({
    ...sessionMutationOptions,
    onError: onMutationError,
  });
  const deleteTerminal = useMutation({
    ...deleteTerminalMutationOptions,
    onError: onMutationError,
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function commit(next: Layout) {
    if (
      blocked.current ||
      changingSession.current ||
      !parseLayout(next, currentResources())
    )
      return;
    layoutRef.current = next;
    setLayout(next);
    setNotice("");
    setPending((n) => n + 1);
    queue.current = queue.current
      .then(async () => {
        if (blocked.current) return;
        const state = await saveLayout.mutateAsync({
          layout: next,
          revision: revision.current,
          sessionId: initialState.selectedSessionId,
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
      void queryClient
        .invalidateQueries(
          { queryKey: ecq.keyOf(workspaceQuery) },
          { throwOnError: true },
        )
        .catch((error: Error) => {
          if (error instanceof AuthenticationError) onAuthRequired();
          setNotice(error.message);
        });
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
    if (!parseLayout(next, currentResources())) {
      setNotice(
        "Layout nesting limit reached. The terminal is available in the detached picker.",
      );
      return;
    }
    commit(next);
  }
  async function newPane(axis: "x" | "y") {
    const current = layoutRef.current;
    if (
      !current ||
      !initialState.selectedSessionId ||
      busy.current ||
      blocked.current
    )
      return;
    if (paneIds(current.root).length >= MAX_PANES) {
      setNotice(`A layout supports up to ${MAX_PANES} panes.`);
      return;
    }
    busy.current = true;
    try {
      const terminal = await createTerminal.mutateAsync(
        initialState.selectedSessionId,
      );
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
      await deleteTerminal.mutateAsync(id);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }
  async function sessionAction(action: SessionAction) {
    if (busy.current || blocked.current) return false;
    busy.current = true;
    changingSession.current = true;
    try {
      await queue.current;
      if (blocked.current) return false;
      const state = await mutateSession.mutateAsync({
        ...action,
        revision: revision.current,
      });
      revision.current = state.revision;
      return true;
    } catch (error) {
      onMutationError(error as Error);
      setNotice((error as Error).message);
      return false;
    } finally {
      busy.current = false;
      changingSession.current = false;
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
      id: "sessions",
      label: "Switch / manage sessions",
      key: "s",
      run: () => openPicker("sessions"),
    },
    {
      id: "create-session",
      label: "Create session",
      key: "",
      run: () => openPicker("create-session"),
    },
    ...(initialState.selectedSessionId
      ? [
          {
            id: "rename-session",
            label: "Rename session",
            key: "",
            run: () => openPicker("rename-session"),
          },
          {
            id: "archive-session",
            label: "Archive session (keep terminals)",
            key: "",
            run: () => {
              void sessionAction({
                action: "archive",
                id: initialState.selectedSessionId!,
              });
            },
          },
        ]
      : []),
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
  useLayoutEffect(() => {
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
  }, [changeMode]);
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
      <div class={styles.toolbar}>
        <span>
          {initialState.sessions.find(
            (s) => s.id === initialState.selectedSessionId,
          )?.name ?? "No session selected"}{" "}
          <span class={styles.muted}>
            {
              initialState.sessions.find(
                (s) => s.id === initialState.selectedSessionId,
              )?.directory
            }
          </span>
        </span>
        <div class={styles.toolbarActions}>
          <button onClick={() => openPicker("sessions")}>
            Sessions <kbd>Ctrl-g s</kbd>
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
      <div class={styles.canvas}>
        {positions
          .filter((p) => p.node.type === "terminal")
          .map(({ node, rect }) => {
            const hidden = !!layout?.zoomedId && layout.zoomedId !== node.id;
            return (
              <section
                key={node.id}
                data-pane-id={node.id}
                aria-label={resources.find((t) => t.id === node.id)?.title}
                data-active={layout?.activeId === node.id}
                class={`${styles.pane} ${layout?.activeId === node.id ? styles.activePane : ""}`}
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
                  register={(handle) => {
                    if (handle) handles.current.set(node.id, handle);
                    else handles.current.delete(node.id);
                  }}
                />
              </section>
            );
          })}
        {!layout ? (
          <p class={styles.empty}>Loading workspace… {notice}</p>
        ) : (
          !layout.root && (
            <div class={styles.empty}>
              <h2>
                {initialState.selectedSessionId
                  ? "No open panes"
                  : "Choose a work session"}
              </h2>
              <p>
                {initialState.selectedSessionId
                  ? "Reopen a detached terminal or start a new one."
                  : "Use Ctrl-g s to create or reopen a session."}
              </p>
              {initialState.selectedSessionId ? (
                <>
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
                </>
              ) : (
                <button onClick={() => openPicker("sessions")}>
                  Choose session
                </button>
              )}
            </div>
          )
        )}
      </div>
      <div
        class={styles.status}
        data-layout-status
        role="status"
        aria-live="polite"
      >
        {notice ||
          (mode === "prefix"
            ? 'Ctrl-g → % split ↔ · " split ↕ · h/j/k/l focus · H/J/K/L resize · z zoom · x close · d detached · s sessions · ? help · Esc cancel'
            : mode === "resize"
              ? "Resize mode · h/j/k/l move boundary · Escape finishes"
              : pending
                ? "Saving layout…"
                : layout?.zoomedId
                  ? "Layout saved · Zoomed · Ctrl-g z to restore"
                  : "Layout saved · Ctrl-g ? for commands")}
      </div>
      {dialog && dialog !== "commands" && dialog !== "terminals" && (
        <SessionDialog
          mode={dialog}
          sessions={initialState.sessions}
          selectedId={initialState.selectedSessionId}
          close={closeDialog}
          act={sessionAction}
          notice={notice}
        />
      )}
      {(dialog === "commands" || dialog === "terminals") && (
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
