import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Workbench } from "./workbench.js";
import "@xterm/xterm/css/xterm.css";
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
        <Workbench onAuthRequired={() => setAuthenticated(false)} />
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
