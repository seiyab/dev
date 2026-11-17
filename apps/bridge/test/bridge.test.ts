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
import { startBridge } from "../src/server.js";
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
  const bridge = startBridge({
    hostname: "127.0.0.1",
    port,
    origin,
    stateDir: dir,
    workspaceDir: dir,
    webRoot: dir,
    shell: "/bin/bash",
    tmuxSocket,
  });
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
) {
  const socket = new WebSocket(f.url, {
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
