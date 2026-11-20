import { ecq } from "@seiyab/ecq";
import { render } from "preact";
import { useCallback, useState } from "preact/hooks";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/preact-query";
import { loginMutationOptions, sessionQuery, workspaceQuery } from "./api.js";
import { Workbench } from "./workbench.js";
import styles from "./main.module.css";
import "./style.css";

function App() {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery());
  const [key, setKey] = useState("");
  const loginMutation = useMutation(loginMutationOptions);
  const onAuthRequired = useCallback(() => {
    queryClient.removeQueries({ queryKey: ecq.keyOf(workspaceQuery) });
    queryClient.setQueryData(sessionQuery().queryKey, false);
  }, [queryClient]);
  function login(event: SubmitEvent) {
    event.preventDefault();
    loginMutation.mutate(key, { onSuccess: () => setKey("") });
  }
  const error = loginMutation.error?.message ?? session.error?.message;
  return (
    <main class={styles.main}>
      <header class={styles.header}>
        <div class={styles.brand}>
          Workbench<span class={styles.badge}>LOCAL</span>
        </div>
        <span class={styles.subtitle}>Development terminal</span>
      </header>
      {session.isPending ? (
        <section class={styles.login}>
          <p>Connecting to your workspace…</p>
        </section>
      ) : session.data ? (
        <Workbench onAuthRequired={onAuthRequired} />
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
            <button class={styles.submit} disabled={loginMutation.isPending}>
              {loginMutation.isPending ? "Connecting…" : "Open terminal"}
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

// Layouts are edited locally with revision-checked saves. Refetch only when
// requested, and never retry or defer writes that may already have succeeded.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      networkMode: "always",
      gcTime: 0,
    },
    mutations: { retry: false, networkMode: "always" },
  },
});

render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>,
  document.getElementById("app")!,
);
