import { useEffect, useRef, useState } from "preact/hooks";
import type { WorkSession, SessionAction } from "@workbench/protocol";
import styles from "./session-dialog.module.css";

export type SessionDialogMode =
  "sessions" | "create-session" | "rename-session";

export function SessionDialog({
  mode,
  sessions,
  selectedId,
  close,
  act,
  notice,
}: {
  mode: SessionDialogMode;
  sessions: WorkSession[];
  selectedId: string | null;
  close: () => void;
  act: (action: SessionAction) => Promise<boolean>;
  notice: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const selected = sessions.find((s) => s.id === selectedId);
  const [view, setView] = useState<SessionDialogMode | "delete">(mode);
  const [target, setTarget] = useState<WorkSession | undefined>(selected);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [name, setName] = useState(
    mode === "rename-session" ? (selected?.name ?? "") : "",
  );
  const [directory, setDirectory] = useState(selected?.directory ?? ".");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    dialog.current
      ?.querySelector<HTMLInputElement | HTMLButtonElement>(
        "input, button[data-initial-focus]",
      )
      ?.focus();
  }, [view]);
  async function submit(action: SessionAction) {
    if (busy) return;
    setBusy(true);
    try {
      if (await act(action)) close();
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      class={styles.dialog}
      aria-labelledby="session-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
    >
      <div class={styles.heading}>
        <h2 id="session-title">
          {view === "sessions"
            ? "Work sessions"
            : view === "create-session"
              ? "Create session"
              : view === "delete"
                ? "Delete session"
                : "Rename session"}
        </h2>
        <button disabled={busy} onClick={close} aria-label="Close dialog">
          ×
        </button>
      </div>
      {notice && <p role="alert">{notice}</p>}
      {view === "sessions" ? (
        <>
          <input
            aria-label="Filter sessions"
            placeholder="Filter sessions…"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button
            disabled={busy}
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? "Hide archived sessions" : "Show archived sessions"}
          </button>
          <div class={styles.list}>
            {sessions
              .filter((s) => showArchived || !s.archived)
              .filter((s) =>
                `${s.name} ${s.directory}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((s) => (
                <div class={styles.row} key={s.id}>
                  <button
                    disabled={busy}
                    class={styles.select}
                    onClick={() => void submit({ action: "select", id: s.id })}
                  >
                    <span>
                      {s.archived ? "Reopen" : "Switch to"} {s.name}
                      {s.id === selectedId ? " (current)" : ""}
                    </span>
                    <small>
                      {s.directory}
                      {s.archived ? " · Archived" : ""}
                    </small>
                  </button>
                  <button
                    disabled={busy}
                    aria-label={`Rename ${s.name}`}
                    onClick={() => {
                      setTarget(s);
                      setName(s.name);
                      setView("rename-session");
                    }}
                  >
                    Rename
                  </button>
                  {!s.archived && (
                    <button
                      disabled={busy}
                      aria-label={`Archive ${s.name}`}
                      onClick={() =>
                        void submit({ action: "archive", id: s.id })
                      }
                    >
                      Archive
                    </button>
                  )}
                  <button
                    disabled={busy}
                    aria-label={`Delete ${s.name}`}
                    onClick={() => {
                      setTarget(s);
                      setView("delete");
                    }}
                  >
                    Delete
                  </button>
                </div>
              ))}
          </div>
          <button
            disabled={busy}
            onClick={() => {
              setName("");
              setView("create-session");
            }}
          >
            Create session
          </button>
        </>
      ) : view === "delete" ? (
        <>
          <p>
            Delete “{target?.name}” and terminate all of its terminals? Its
            saved layout will be removed. Files in its directory will remain.
          </p>
          <div class={styles.actions}>
            <button
              data-initial-focus
              disabled={busy}
              onClick={() => setView("sessions")}
            >
              Cancel
            </button>
            <button
              disabled={busy}
              onClick={() =>
                target && void submit({ action: "delete", id: target.id })
              }
            >
              Delete session and terminate terminals
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (view === "create-session")
              void submit({ action: "create", name, directory });
            else if (target)
              void submit({ action: "rename", id: target.id, name });
          }}
        >
          <label>
            Session name
            <input
              required
              maxLength={80}
              value={name}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </label>
          {view === "create-session" && (
            <label>
              Working directory
              <input
                required
                value={directory}
                onInput={(e) => setDirectory(e.currentTarget.value)}
              />
              <small>
                Existing directory inside the workspace. Relative paths start at
                the workspace root.
              </small>
            </label>
          )}
          <div class={styles.actions}>
            <button
              type="button"
              disabled={busy}
              onClick={() => setView("sessions")}
            >
              Back
            </button>
            <button disabled={busy} type="submit">
              {view === "create-session" ? "Create session" : "Save name"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}
