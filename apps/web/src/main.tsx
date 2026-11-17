import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Workbench } from "./workbench.js";
import styles from "./main.module.css";
import "./style.css";

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
    <main class={styles.main}>
      <header class={styles.header}>
        <div class={styles.brand}>
          Workbench<span class={styles.badge}>LOCAL</span>
        </div>
        <span class={styles.subtitle}>Development terminal</span>
      </header>
      {authenticated === null ? (
        <section class={styles.login}>
          <p>Connecting to your workspace…</p>
        </section>
      ) : authenticated ? (
        <Workbench onAuthRequired={() => setAuthenticated(false)} />
      ) : (
        <section class={styles.login}>
          <form class={styles.form} onSubmit={login}>
            <p class={styles.eyebrow}>YOUR WORKSPACE</p>
            <h1 class={styles.heading}>Pick up where you left off.</h1>
            <p class={styles.description}>
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
            <button class={styles.submit} disabled={busy}>
              {busy ? "Connecting…" : "Open terminal"}
            </button>
            {error && (
              <p class={styles.error} role="alert">
                {error}
              </p>
            )}
          </form>
        </section>
      )}
    </main>
  );
}

render(<App />, document.getElementById("app")!);
