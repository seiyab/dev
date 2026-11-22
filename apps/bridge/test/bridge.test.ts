import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { request } from "node:http";
import { test } from "node:test";
import { WebSocket } from "ws";
import { startBridge } from "../src/api/server.js";
import {
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@workbench/protocol";

async function fixture() {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  const dir = mkdtempSync(join(tmpdir(), "workbench-test-"));
  const origin = `http://127.0.0.1:${port}`;
  const tmuxSocket = `wb-test-${port}`;
  const config = {
    hostname: "127.0.0.1",
    port,
    origin,
    stateDir: dir,
    workspaceDir: dir,
    webRoot: dir,
    shell: "/bin/bash",
    tmuxSocket,
  };
  let bridge = startBridge(config);
  await once(bridge.server, "listening");
  const key = readFileSync(join(dir, "access-key"), "utf8").trim();
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  return {
    origin,
    cookie,
    key,
    dir,
    restart: async () => {
      await bridge.close();
      bridge = startBridge(config);
      await once(bridge.server, "listening");
      // Use a fresh connection after restart instead of fetch's old keep-alive pool.
      return new Promise<string>((done, reject) => {
        const req = request(
          `${origin}/api/login`,
          {
            method: "POST",
            agent: false,
            headers: { Origin: origin, "Content-Type": "application/json" },
          },
          (response) => {
            response.resume();
            done(response.headers["set-cookie"]![0].split(";")[0]);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify({ key }));
      });
    },
    url: origin.replace("http:", "ws:") + "/api/terminal?v=1",
    close: async () => {
      await bridge.close();
      try {
        execFileSync("tmux", ["-L", tmuxSocket, "kill-server"], {
          stdio: "ignore",
        });
      } catch {
        /* Already exited. */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function denied(
  url: string,
  origin: string | undefined,
  cookie?: string,
) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(url, {
      origin,
      headers: cookie ? { Cookie: cookie } : undefined,
    });
    socket.on("unexpected-response", (_request, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    });
    socket.on("error", () => {});
    socket.on("open", () => {
      socket.close();
      reject(new Error("Unexpected upgrade"));
    });
  });
}

async function attach(
  f: Awaited<ReturnType<typeof fixture>>,
  acknowledge = true,
  id = "terminal",
) {
  const socket = new WebSocket(`${f.url}&id=${id}`, {
    origin: f.origin,
    headers: { Cookie: f.cookie },
  });
  let output = "";
  let ready = false;
  socket.on("message", (raw) => {
    const msg = JSON.parse(raw.toString()) as ServerMessage;
    if (msg.type === "ready") ready = true;
    if (msg.type === "output") {
      output += msg.data;
      if (acknowledge)
        socket.send(
          JSON.stringify({ type: "ack", bytes: Buffer.byteLength(msg.data) }),
        );
    }
  });
  await once(socket, "open");
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 7000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error(
          `Terminal condition timed out. Tail: ${output.slice(-500)}`,
        );
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  await waitFor(() => ready);
  return {
    socket,
    output: () => output,
    waitFor,
    send: (msg: ClientMessage) => socket.send(JSON.stringify(msg)),
    detach: async () => {
      socket.close();
      await once(socket, "close");
      await new Promise((done) => setTimeout(done, 50));
    },
  };
}

test(
  "rejects invalid authentication, hosts, origins, and competing controllers",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      assert.equal((await fetch(`${f.origin}/api/session`)).status, 401);
      const badHost = await new Promise<number>((done, reject) => {
        request(
          `${f.origin}/api/session`,
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            done(response.statusCode!);
          },
        )
          .on("error", reject)
          .end();
      });
      assert.equal(badHost, 403);
      assert.equal(
        (
          await fetch(`${f.origin}/api/login`, {
            method: "POST",
            headers: { Origin: "http://evil.example" },
            body: "{}",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(`${f.origin}/api/login`, {
            method: "POST",
            headers: { Origin: f.origin },
            body: JSON.stringify({ key: "wrong" }),
          })
        ).status,
        401,
      );
      assert.equal(await denied(f.url, f.origin), 401);
      assert.equal(await denied(f.url, "http://evil.example", f.cookie), 403);
      assert.equal(await denied(f.url, undefined, f.cookie), 403);
      assert.equal(
        await denied(f.url.replace("v=1", "v=99"), f.origin, f.cookie),
        400,
      );
      const terminal = await attach(f);
      assert.equal(await denied(f.url, f.origin, f.cookie), 409);
      await terminal.detach();
      const next = await attach(f);
      next.socket.send(JSON.stringify({ type: "resize", cols: -1, rows: 24 }));
      const [code] = await once(next.socket, "close");
      assert.equal(code, 1008);
    } finally {
      await f.close();
    }
  },
);

test(
  "PTY resizes, shell state survives detach, and acknowledged high output drains",
  { timeout: 30000 },
  async () => {
    const f = await fixture();
    try {
      const terminal = await attach(f);
      await terminal.waitFor(
        () =>
          terminal.output().includes("$ ") || terminal.output().includes("# "),
      );
      terminal.send({ type: "resize", cols: 101, rows: 33 });
      terminal.send({
        type: "input",
        data: "export WB_KEEP=survived; stty size\r",
      });
      await terminal.waitFor(() => terminal.output().includes("33 101"));
      terminal.send({
        type: "input",
        data: "for i in $(seq 1 120); do head -c 2048 /dev/urandom | base64; sleep 0.01; done; printf 'DONE_%s\\n' output\r",
      });
      await terminal.waitFor(() => terminal.output().includes("DONE_output"));
      assert.ok(terminal.output().length > 128 * 1024);
      await terminal.detach();
      const reattached = await attach(f);
      reattached.send({
        type: "input",
        data: "printf 'STATE_%s\\n' \"$WB_KEEP\"\r",
      });
      await reattached.waitFor(() =>
        reattached.output().includes("STATE_survived"),
      );
      await reattached.detach();
    } finally {
      await f.close();
    }
  },
);

test(
  "slow consumers pause output until they acknowledge it",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const terminal = await attach(f, false);
      await terminal.waitFor(
        () =>
          terminal.output().includes("$ ") || terminal.output().includes("# "),
      );
      terminal.send({
        type: "input",
        data: "for i in $(seq 1 240); do head -c 2048 /dev/urandom | base64; sleep 0.01; done; printf 'DRAIN_%s\\n' complete\r",
      });
      await terminal.waitFor(
        () => Buffer.byteLength(terminal.output()) >= 128 * 1024,
      );
      await new Promise((done) => setTimeout(done, 200));
      const pausedLength = Buffer.byteLength(terminal.output());
      await new Promise((done) => setTimeout(done, 200));
      assert.equal(Buffer.byteLength(terminal.output()), pausedLength);
      assert.ok(pausedLength < 256 * 1024);
      // Switch to acknowledging newly received data and release the accumulated output.
      terminal.socket.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as ServerMessage;
        if (msg.type === "output")
          terminal.send({ type: "ack", bytes: Buffer.byteLength(msg.data) });
      });
      terminal.send({ type: "ack", bytes: pausedLength });
      await terminal.waitFor(() =>
        terminal.output().includes("DRAIN_complete"),
      );
      await terminal.detach();
    } finally {
      await f.close();
    }
  },
);

test("protocol rejects malformed and oversized messages", () => {
  for (const raw of [
    "null",
    "[]",
    "{",
    JSON.stringify({ type: "input", data: "a".repeat(9000) }),
    JSON.stringify({ type: "resize", cols: 80.5, rows: 24 }),
    JSON.stringify({ type: "ack", bytes: 0 }),
  ])
    assert.equal(parseClientMessage(raw), null);
});

test(
  "multiple terminals, validated layouts, revision conflicts and bridge restarts",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(`${f.origin}/api/${path}`, {
        method,
        headers: {
          Cookie: f.cookie,
          Origin: f.origin,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    try {
      const created = await api("terminals", "POST");
      assert.equal(created.status, 201);
      const second = await created.json();
      const a = await attach(f);
      const b = await attach(f, true, second.id);
      a.send({
        type: "input",
        data: "export ISOLATED=alpha; printf 'READY_%s\\n' alpha\r",
      });
      b.send({
        type: "input",
        data: "export ISOLATED=beta; printf 'READY_%s\\n' beta\r",
      });
      await a.waitFor(() => a.output().includes("READY_alpha"));
      await b.waitFor(() => b.output().includes("READY_beta"));
      assert.equal(
        await denied(`${f.url}&id=${second.id}`, f.origin, f.cookie),
        409,
      );
      assert.equal(
        await denied(`${f.url}&id=unregistered`, f.origin, f.cookie),
        404,
      );
      const initial = await (await api("workspace")).json();
      const layout = {
        root: {
          type: "split",
          id: "split-one",
          axis: "x",
          ratio: 0.6,
          first: { type: "terminal", id: "terminal" },
          second: { type: "terminal", id: second.id },
        },
        activeId: second.id,
        zoomedId: null,
      };
      assert.equal(
        (await api("layout", "PUT", { revision: initial.revision, layout }))
          .status,
        200,
      );
      assert.equal(
        (await api("layout", "PUT", { revision: initial.revision, layout }))
          .status,
        409,
      );
      const current = await (await api("workspace")).json();
      const duplicate = {
        ...layout,
        root: { ...layout.root, second: { type: "terminal", id: "terminal" } },
      };
      assert.equal(
        (
          await api("layout", "PUT", {
            revision: current.revision,
            layout: duplicate,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await api("layout", "PUT", {
            revision: current.revision,
            layout: { ...layout, root: { ...layout.root, ratio: 0.99 } },
          })
        ).status,
        400,
      );
      await a.detach();
      await b.detach();
      assert.equal((await api(`terminals/${second.id}`, "DELETE")).status, 409);
      f.cookie = await f.restart();
      const restored = await (await api("workspace")).json();
      assert.deepEqual(restored.layout, layout);
      assert.equal(restored.revision, current.revision);
      const againA = await attach(f);
      const againB = await attach(f, true, second.id);
      againA.send({
        type: "input",
        data: "printf 'RESTORED_%s\\n' \"$ISOLATED\"\r",
      });
      againB.send({
        type: "input",
        data: "printf 'RESTORED_%s\\n' \"$ISOLATED\"\r",
      });
      await againA.waitFor(() => againA.output().includes("RESTORED_alpha"));
      await againB.waitFor(() => againB.output().includes("RESTORED_beta"));
      await againA.detach();
      await againB.detach();
      const closed = { root: null, activeId: null, zoomedId: null };
      assert.equal(
        (
          await api("layout", "PUT", {
            revision: restored.revision,
            layout: closed,
          })
        ).status,
        200,
      );
      assert.equal((await api(`terminals/${second.id}`, "DELETE")).status, 200);
      assert.equal(
        await denied(`${f.url}&id=${second.id}`, f.origin, f.cookie),
        404,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "ended terminals require explicit recreation",
  { timeout: 15000 },
  async () => {
    const f = await fixture();
    try {
      const terminal = await attach(f);
      await terminal.waitFor(
        () =>
          terminal.output().includes("$ ") || terminal.output().includes("# "),
      );
      terminal.send({ type: "input", data: "exit\r" });
      await once(terminal.socket, "close");
      assert.equal(await denied(f.url, f.origin, f.cookie), 410);
      const recreate = await fetch(
        `${f.origin}/api/terminals/terminal/recreate`,
        { method: "POST", headers: { Cookie: f.cookie, Origin: f.origin } },
      );
      assert.equal(recreate.status, 200);
      const restarted = await attach(f);
      await restarted.waitFor(
        () =>
          restarted.output().includes("$ ") ||
          restarted.output().includes("# "),
      );
      await restarted.detach();
    } finally {
      await f.close();
    }
  },
);

test(
  "shells receive scoped broker connection settings but not GitHub credentials",
  { timeout: 15_000 },
  async () => {
    const values: Record<string, string> = {
      BOX_BROKER_URL: "http://git-broker:3180",
      BOX_CAPABILITY_FILE: "/run/secrets/box-capability",
      GH_TOKEN: "must-not-reach-shell",
      GITHUB_TOKEN: "must-not-reach-shell",
    };
    const previous = Object.fromEntries(
      Object.keys(values).map((key) => [key, process.env[key]]),
    );
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      Object.assign(process.env, values);
      f = await fixture();
      const terminal = await attach(f);
      terminal.send({
        type: "input",
        data: 'printf \'BROKER_%s|%s|%s|%s\\n\' "$BOX_BROKER_URL" "$BOX_CAPABILITY_FILE" "${GH_TOKEN-unset}" "${GITHUB_TOKEN-unset}"\r',
      });
      await terminal.waitFor(() =>
        terminal
          .output()
          .includes(
            "BROKER_http://git-broker:3180|/run/secrets/box-capability|unset|unset",
          ),
      );
      await terminal.detach();
    } finally {
      await f?.close();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  },
);
