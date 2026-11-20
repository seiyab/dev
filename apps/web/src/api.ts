import { ecq } from "@seiyab/ecq";
import { mutationOptions } from "@tanstack/preact-query";
import type {
  Layout,
  SessionAction,
  TerminalResource,
  WorkspaceState,
} from "@workbench/protocol";

export class AuthenticationError extends Error {
  constructor() {
    super("Authentication expired");
  }
}

export async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(path, options);
  if (response.status === 401) throw new AuthenticationError();
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export const workspaceQuery = ecq.query(
  () => request<WorkspaceState>("/api/workspace"),
  { key: "workspace" },
);

export const sessionQuery = ecq.query(
  async () => {
    try {
      await request<unknown>("/api/session");
      return true;
    } catch (error) {
      if (error instanceof AuthenticationError) return false;
      throw new Error("Bridge unavailable");
    }
  },
  { key: "session" },
);

export const loginMutationOptions = mutationOptions({
  mutationFn: async (key: string) => {
    let response: Response;
    try {
      response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
    } catch {
      throw new Error("Bridge unavailable");
    }
    if (!response.ok) throw new Error(await response.text());
  },
  onSuccess: (_data, _variables, _onMutateResult, { client }) => {
    client.setQueryData(sessionQuery().queryKey, true);
  },
});

export const saveLayoutMutationOptions = mutationOptions({
  mutationFn: ({
    layout,
    revision,
    sessionId,
  }: {
    layout: Layout;
    revision: number;
    sessionId: string | null;
  }) =>
    request<WorkspaceState>("/api/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revision, layout, sessionId }),
      keepalive: true,
    }),
});

export const createTerminalMutationOptions = mutationOptions({
  mutationFn: (sessionId: string | null) =>
    request<TerminalResource>("/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }),
  onSuccess: (terminal, _variables, _onMutateResult, { client }) => {
    // Keep confirmed resources available even if the subsequent refresh fails.
    client.setQueryData<WorkspaceState>(workspaceQuery().queryKey, (state) =>
      state ? { ...state, terminals: [...state.terminals, terminal] } : state,
    );
    return client.invalidateQueries({
      queryKey: ecq.keyOf(workspaceQuery),
    });
  },
});

export const deleteTerminalMutationOptions = mutationOptions({
  mutationFn: (id: string) =>
    request<WorkspaceState>(`/api/terminals/${id}`, { method: "DELETE" }),
  onSuccess: (result, _variables, _onMutateResult, { client }) => {
    client.setQueryData<WorkspaceState>(workspaceQuery().queryKey, (state) =>
      state ? { ...state, terminals: result.terminals } : state,
    );
    return client.invalidateQueries({
      queryKey: ecq.keyOf(workspaceQuery),
    });
  },
});

export const sessionMutationOptions = mutationOptions({
  mutationFn: (action: SessionAction & { revision: number }) =>
    request<WorkspaceState>("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    }),
  onSuccess: async (state, _variables, _onMutateResult, { client }) => {
    await client.cancelQueries({ queryKey: workspaceQuery().queryKey });
    client.setQueryData(workspaceQuery().queryKey, state);
  },
});
