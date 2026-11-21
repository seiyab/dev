import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkspaceState } from "@workbench/protocol";
import { workspaceStore } from "../src/api/state/workspace.js";
import { startBridge } from "../src/api/server.js";

test("legacy workspace migration preserves terminal identities, layout, and revision", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-migrate-"));
  try {
    const layout = {
      root: { type: "terminal", id: "legacy" },
      activeId: "legacy",
      zoomedId: null,
    };
    writeFileSync(
      join(dir, "workspace.json"),
      JSON.stringify({
        version: 1,
        revision: 17,
        terminals: [{ id: "legacy", title: "Existing", started: true }],
        layout,
      }),
    );
    const state = workspaceStore(dir, dir).get();
    assert.equal(state.version, 2);
    assert.equal(state.revision, 17);
    assert.equal(state.selectedSessionId, "default");
    assert.deepEqual(state.layout, layout);
    assert.deepEqual(state.sessions, [
      {
        id: "default",
        name: "Default",
        directory: dir,
        archived: false,
        layout,
      },
    ]);
    assert.deepEqual(state.terminals, [
      { id: "legacy", title: "Existing", started: true, sessionId: "default" },
    ]);
    assert.deepEqual(workspaceStore(dir, dir).get(), state);
    assert.equal(
      JSON.parse(readFileSync(join(dir, "workspace.json"), "utf8")).version,
      2,
    );
    const malformed = {
      ...state,
      terminals: [{ ...state.terminals[0], sessionId: "missing" }],
    };
    writeFileSync(join(dir, "workspace.json"), JSON.stringify(malformed));
    assert.throws(() => workspaceStore(dir, dir), /Invalid work sessions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session APIs validate directories, ownership, revisions, and durable selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-sessions-"));
  const root = join(dir, "projects");
  mkdirSync(join(root, "project"), { recursive: true });
  symlinkSync(dir, join(root, "escape"));
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const config = {
    hostname: "127.0.0.1",
    port,
    origin: `http://127.0.0.1:${port}`,
    stateDir: dir,
    workspaceDir: root,
    webRoot: dir,
    shell: "/bin/bash",
    tmuxSocket: `wb-sessions-${process.pid}`,
  };
  const bridge = startBridge(config);
  await once(bridge.server, "listening");
  const origin = `http://127.0.0.1:${(bridge.server.address() as { port: number }).port}`;
  let cookie = "";
  async function api(path: string, method = "GET", body?: unknown) {
    return fetch(origin + "/api/" + path, {
      method,
      headers: {
        Origin: config.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  try {
    const login = await api("login", "POST", {
      key: readFileSync(join(dir, "access-key"), "utf8").trim(),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    let state: WorkspaceState = await (await api("workspace")).json();
    for (const directory of [
      "..",
      "escape",
      "missing",
      "project/missing",
      "/tmp",
    ]) {
      assert.equal(
        (
          await api("sessions", "POST", {
            action: "create",
            name: "Invalid",
            directory,
            revision: state.revision,
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await api("sessions", "POST", {
          action: "create",
          name: "",
          directory: ".",
          revision: state.revision,
        })
      ).status,
      400,
    );
    const created = await api("sessions", "POST", {
      action: "create",
      name: "Project",
      directory: "project",
      revision: state.revision,
    });
    assert.equal(created.status, 201);
    state = await created.json();
    const id = state.selectedSessionId!;
    assert.equal(
      state.sessions.find((s) => s.id === id)?.directory,
      join(root, "project"),
    );
    assert.equal(
      state.terminals.find((t) => t.id === state.layout.activeId)?.sessionId,
      id,
    );
    assert.equal(
      (
        await api("layout", "PUT", {
          revision: state.revision,
          sessionId: id,
          layout: {
            root: { type: "terminal", id: "terminal" },
            activeId: "terminal",
            zoomedId: null,
          },
        })
      ).status,
      400,
    );
    assert.equal(
      (await api("terminals", "POST", { sessionId: "default" })).status,
      409,
    );
    assert.equal(
      (
        await api("sessions", "POST", {
          action: "select",
          id: "default",
          revision: state.revision - 1,
        })
      ).status,
      409,
    );
    // A pane belonging to any session protects its terminal, even when that session is inactive.
    assert.equal((await api("terminals/terminal", "DELETE")).status, 409);
    state = await (
      await api("sessions", "POST", {
        action: "archive",
        id,
        revision: state.revision,
      })
    ).json();
    assert.equal(state.selectedSessionId, "default");
    assert.equal(state.sessions.find((s) => s.id === id)?.archived, true);
    state = await (
      await api("sessions", "POST", {
        action: "select",
        id,
        revision: state.revision,
      })
    ).json();
    assert.equal(state.sessions.find((s) => s.id === id)?.archived, false);
    assert.deepEqual(workspaceStore(dir, root).get(), state);
    state = await (
      await api("sessions", "POST", {
        action: "delete",
        id,
        revision: state.revision,
      })
    ).json();
    assert.equal(state.selectedSessionId, "default");
    assert.equal(state.sessions.length, 1);
    assert.equal(state.terminals.length, 1);
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
