import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as pty from "node-pty";
import {
  newCapability,
  startGitBroker,
  type BrokerConfig,
} from "../src/server.js";

const exec = promisify(execFile);
const helperPath = resolve("apps/git-broker/bin");
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "box-broker-test-"));
  const seed = join(directory, "seed");
  const upstream = join(directory, "upstream.git");
  const checkout = join(directory, "checkout");
  const stateDir = join(directory, "state");
  const token = newCapability();
  const otherToken = newCapability();
  const otherCapabilityFile = join(directory, "other-capability");
  await writeFile(otherCapabilityFile, otherToken, { mode: 0o600 });
  const capabilityFile = join(directory, "capability");
  await writeFile(capabilityFile, token, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: helperPath + ":" + process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Box Test",
    GIT_AUTHOR_EMAIL: "box@example.invalid",
    GIT_COMMITTER_NAME: "Box Test",
    GIT_COMMITTER_EMAIL: "box@example.invalid",
  };
  const git = async (args: string[], cwd = checkout) =>
    (await exec("git", args, { cwd, env, timeout: 30_000 })).stdout.trim();
  await mkdir(seed);
  await git(["init", "-b", "main"], seed);
  await writeFile(join(seed, "file"), "initial\n");
  await git(["add", "."], seed);
  await git(["commit", "-m", "Initial"], seed);
  await git(["clone", "--bare", seed, upstream], directory);
  await git(["clone", upstream, checkout], directory);
  await git(["config", "remote.origin.pushurl", "box::demo/repo"]);
  const config: BrokerConfig = {
    port: 0,
    stateDir,
    repositories: [{ id: "demo/repo", upstream }],
    boxes: [
      { id: "demo", capabilityFile, repositories: ["demo/repo"] },
      {
        id: "other",
        capabilityFile: otherCapabilityFile,
        repositories: ["demo/repo"],
      },
    ],
  };
  let broker = await startGitBroker(config);
  env.BOX_BROKER_URL = broker.url;
  env.BOX_CAPABILITY_FILE = capabilityFile;
  async function api(path: string, body?: unknown, capability = token) {
    return fetch(broker.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${capability}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  return {
    directory,
    checkout,
    upstream,
    stateDir,
    env,
    git,
    api,
    config,
    otherToken,
    commit: async (text: string) => {
      await writeFile(join(checkout, "file"), text + "\n");
      await git(["commit", "-am", text]);
      return git(["rev-parse", "HEAD"]);
    },
    bundle: async () => {
      const file = join(directory, "outgoing.bundle");
      await rm(file, { force: true });
      await git(["bundle", "create", file, "HEAD"]);
      return (await readFile(file)).toString("base64");
    },
    upstreamTip: (ref: string) =>
      git(["--git-dir", upstream, "rev-parse", "--verify", ref], directory),
    restart: async () => {
      await broker.close();
      broker = await startGitBroker(config);
      env.BOX_BROKER_URL = broker.url;
    },
    close: async () => {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const pushPath = "/v1/repos/demo/repo/push";

test("ordinary pushes create owned branches, set upstream tracking, and preserve public fetch", async () => {
  const f = await fixture();
  try {
    assert.ok(
      (await f.git(["ls-remote", "box::demo/repo"])).includes(
        "refs/heads/main",
      ),
    );
    await f.git(["switch", "-c", "box/demo/topic"]);
    await f.commit("first");
    await f.git(["push", "-u", "origin", "HEAD"]);
    assert.equal(
      await f.git(["rev-parse", "--abbrev-ref", "@{upstream}"]),
      "origin/box/demo/topic",
    );
    assert.equal(await f.git(["config", "remote.origin.url"]), f.upstream);
    assert.equal(
      await f.upstreamTip("refs/heads/box/demo/topic"),
      await f.git(["rev-parse", "HEAD"]),
    );
    await f.restart();
    const next = await f.commit("second");
    await f.git(["push"]);
    assert.equal(await f.upstreamTip("refs/heads/box/demo/topic"), next);
    await f.git(["fetch", "origin"]);
    assert.equal(await f.git(["rev-parse", "origin/box/demo/topic"]), next);
    assert.equal(await f.git(["for-each-ref", "refs/box-upload"]), "");
    const audit = await readFile(join(f.stateDir, "audit.jsonl"), "utf8");
    assert.ok(audit.includes('"outcome":"pushed"'));
    assert.ok(
      !audit.includes(await readFile(f.config.boxes[0].capabilityFile, "utf8")),
    );
  } finally {
    await f.close();
  }
});

test("helper rejects protected refs, tags, deletion, rewrites, preexisting branches, and multi-ref pushes", async () => {
  const f = await fixture();
  try {
    await f.git(["switch", "-c", "box/demo/topic"]);
    await f.commit("owned");
    await f.git(["push", "-u", "origin", "HEAD"]);
    await assert.rejects(
      f.git(["push", "origin", "HEAD:main"]),
      /outside.*namespace/,
    );
    await assert.rejects(
      f.git(["push", "origin", "HEAD:box/other/topic"]),
      /outside.*namespace/,
    );
    await assert.rejects(
      f.git(["push", "origin", "HEAD:refs/tags/release"]),
      /outside.*namespace/,
    );
    await assert.rejects(
      f.git(["push", "origin", "--delete", "box/demo/topic"]),
      /deletion/,
    );
    await f.git(["push", f.upstream, "HEAD:refs/heads/box/demo/preexisting"]);
    await f.commit("new tip");
    await assert.rejects(
      f.git(["push", "origin", "HEAD:box/demo/preexisting"]),
      /not recorded as owned/,
    );
    await assert.rejects(
      f.git(["push", "origin", "HEAD:box/demo/a", "HEAD:box/demo/b"]),
      /one branch update/,
    );
    await assert.rejects(f.upstreamTip("refs/heads/box/demo/a"));
    const originalTip = await f.upstreamTip("refs/heads/box/demo/topic");
    await f.git(["reset", "--hard", "main"]);
    await f.commit("divergent");
    await assert.rejects(
      f.git(["push", "--force", "origin", "HEAD"]),
      /History rewrites/,
    );
    assert.equal(await f.upstreamTip("refs/heads/box/demo/topic"), originalTip);
  } finally {
    await f.close();
  }
});

test("direct API calls enforce grants, refs, object validation, and stale update protection", async () => {
  const f = await fixture();
  try {
    const oid = await f.git(["rev-parse", "HEAD"]);
    const request = {
      ref: "refs/heads/box/demo/direct",
      expectedOid: null,
      newOid: oid,
      bundle: await f.bundle(),
      dryRun: false,
      boxId: "other",
    };
    assert.equal(
      (await f.api("/v1/repos/demo/repo", undefined, newCapability())).status,
      401,
    );
    assert.equal(
      (await f.api("/v1/repos/demo/denied/push", request)).status,
      403,
    );
    assert.equal(
      (await f.api(pushPath, { ...request, ref: "refs/heads/main" })).status,
      403,
    );
    assert.equal(
      (await f.api(pushPath, { ...request, ref: "refs/heads/box/other/topic" }))
        .status,
      403,
    );
    assert.equal(
      (await f.api(pushPath, { ...request, boxId: "demo" }, f.otherToken))
        .status,
      403,
    );
    await f.git(["push", f.upstream, "HEAD:refs/heads/box/demo/existing"]);
    assert.equal(
      (
        await f.api(pushPath, {
          ...request,
          ref: "refs/heads/box/demo/existing",
          expectedOid: oid,
        })
      ).status,
      403,
    );
    assert.equal(
      (await f.api(pushPath, { ...request, newOid: null })).status,
      403,
    );
    assert.equal(
      (await f.api(pushPath, { ...request, newOid: "1".repeat(40) })).status,
      400,
    );
    assert.equal(
      (
        await f.api(pushPath, {
          ...request,
          newOid: await f.git(["rev-parse", "HEAD:file"]),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api(pushPath, {
          ...request,
          bundle: "A".repeat(Math.ceil((8 * 1024 * 1024) / 3) * 4 + 4),
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await f.api(pushPath, {
          ...request,
          bundle: Buffer.from("not a bundle").toString("base64"),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.api(pushPath, {
          ...request,
          ref: "refs/heads/box/demo/../main",
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.api(pushPath, { ...request, dryRun: true })).status,
      200,
    );
    await assert.rejects(f.upstreamTip(request.ref));
    await assert.rejects(readFile(join(f.stateDir, "ownership.json")));
    assert.equal((await f.api(pushPath, request)).status, 200);
    const one = {
      ...request,
      expectedOid: oid,
      newOid: await f.commit("one"),
      bundle: await f.bundle(),
    };
    const two = {
      ...request,
      expectedOid: oid,
      newOid: await f.commit("two"),
      bundle: await f.bundle(),
    };
    const responses = await Promise.all([
      f.api(pushPath, one),
      f.api(pushPath, two),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.ok(
      [one.newOid, two.newOid].includes(await f.upstreamTip(request.ref)),
    );
    await f.git(["reset", "--hard", oid]);
    await f.commit("rewrite via HTTP");
    assert.equal(
      (
        await f.api(pushPath, {
          ...request,
          expectedOid: await f.upstreamTip(request.ref),
          newOid: await f.git(["rev-parse", "HEAD"]),
          bundle: await f.bundle(),
        })
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("dry-run does not publish or claim ownership and upstream rejection is a failed push", async () => {
  const f = await fixture();
  try {
    await f.git(["switch", "-c", "box/demo/topic"]);
    await f.commit("first");
    await f.git(["push", "--dry-run", "-u", "origin", "HEAD"]);
    await assert.rejects(f.upstreamTip("refs/heads/box/demo/topic"));
    await assert.rejects(readFile(join(f.stateDir, "ownership.json")));
    await f.git(["push", "-u", "origin", "HEAD"]);
    const before = await f.upstreamTip("refs/heads/box/demo/topic");
    await f.git([
      "--git-dir",
      f.upstream,
      "config",
      "receive.maxInputSize",
      "1",
    ]);
    await f.commit("will be rejected");
    await assert.rejects(f.git(["push"]), /Upstream rejected/);
    assert.equal(await f.upstreamTip("refs/heads/box/demo/topic"), before);
  } finally {
    await f.close();
  }
});

test("a pending creation reconciles only its exact reserved tip after restart", async () => {
  const f = await fixture();
  try {
    await f.git(["switch", "-c", "box/demo/topic"]);
    await f.git(["push", "-u", "origin", "HEAD"]);
    const file = join(f.stateDir, "ownership.json");
    const state = JSON.parse(await readFile(file, "utf8"));
    const key = "demo/repo\0refs/heads/box/demo/topic";
    // Model a crash after upstream acceptance but before the ownership commit.
    state.ownership[key].status = "pending";
    await writeFile(file, JSON.stringify(state));
    await f.restart();
    await f.commit("after restart");
    await f.git(["push"]);
    assert.equal(
      JSON.parse(await readFile(file, "utf8")).ownership[key].status,
      "owned",
    );
    state.ownership[key].tip = "1".repeat(40);
    await writeFile(file, JSON.stringify(state));
    await f.restart();
    await f.commit("uncertain ownership");
    await assert.rejects(f.git(["push"]), /trusted reconciliation/);
  } finally {
    await f.close();
  }
});

const lazygit = process.env.BOX_TEST_LAZYGIT ?? "lazygit";
test(
  "lazygit default push uses the remote helper",
  { timeout: 20_000 },
  async (t) => {
    try {
      await exec(lazygit, ["--version"]);
    } catch {
      t.skip("Set BOX_TEST_LAZYGIT to a lazygit executable");
      return;
    }
    const f = await fixture();
    let terminal: pty.IPty | undefined;
    try {
      await f.git(["switch", "-c", "box/demo/lazygit"]);
      await f.commit("first");
      await f.git(["push", "-u", "origin", "HEAD"]);
      const oid = await f.commit("from lazygit");
      const configuration = join(f.directory, "lazygit.yml");
      await writeFile(
        configuration,
        "disableStartupPopups: true\ngit:\n  autoFetch: false\nupdate:\n  method: never\n",
      );
      terminal = pty.spawn(
        lazygit,
        [
          "--path",
          f.checkout,
          "--use-config-file",
          configuration,
          "--use-config-dir",
          join(f.directory, "lazygit-config"),
        ],
        {
          cwd: f.checkout,
          env: { ...f.env, TERM: "xterm-256color" },
          cols: 120,
          rows: 40,
        },
      );
      let output = "";
      terminal.onData((data) => {
        output += data;
      });
      const deadline = Date.now() + 12_000;
      while (!output.includes("from") && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      terminal.write("P");
      while (Date.now() < deadline) {
        if ((await f.upstreamTip("refs/heads/box/demo/lazygit")) === oid)
          return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(
        "Lazygit push did not reach upstream. UI tail: " + output.slice(-2000),
      );
    } finally {
      terminal?.kill();
      await f.close();
    }
  },
);

test(
  "bundled broker starts without node_modules and health reveals no grants",
  { timeout: 10_000 },
  async () => {
    const f = await fixture();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const entry = join(f.directory, "broker.mjs");
      await copyFile(resolve("apps/git-broker/dist/index.js"), entry);
      const policy = join(f.directory, "policy.json");
      await writeFile(
        policy,
        JSON.stringify({
          ...f.config,
          stateDir: join(f.directory, "standalone-state"),
        }),
      );
      child = spawn(process.execPath, [entry, policy], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let errors = "";
      child.stdout?.on("data", (data) => {
        output += data.toString();
      });
      child.stderr?.on("data", (data) => {
        errors += data.toString();
      });
      const deadline = Date.now() + 5_000;
      while (
        !output.includes("http://") &&
        Date.now() < deadline &&
        child.exitCode === null
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const url = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0];
      assert.ok(url, "Standalone startup failed: " + errors);
      const health = await fetch(url + "/health");
      assert.deepEqual(await health.json(), { ok: true });
      assert.equal((await fetch(url + "/v1/repos/demo/repo")).status, 401);
      const token = (
        await readFile(f.config.boxes[0].capabilityFile, "utf8")
      ).trim();
      const response = await fetch(url + "/v1/repos/demo/repo", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      assert.ok(
        (await response.json()).refs.some(
          (ref: { name: string }) => ref.name === "refs/heads/main",
        ),
      );
    } finally {
      if (child && child.exitCode === null) {
        const ended = once(child, "exit");
        child.kill("SIGTERM");
        await ended;
      }
      await f.close();
    }
  },
);

test("container health probe preserves the configured Host over loopback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "box-health-test-"));
  const broker = await startGitBroker({
    port: 0,
    allowedHost: "git-broker:3180",
    stateDir: directory,
    repositories: [],
    boxes: [],
  });
  try {
    // This is the previous probe: fetch silently substitutes the connection Host.
    const rejected = await fetch(broker.url + "/health", {
      headers: { Host: "git-broker:3180" },
    });
    assert.equal(rejected.status, 403);
    const port = new URL(broker.url).port;
    await exec(process.execPath, [
      resolve("apps/git-broker/dist/healthcheck.js"),
      port,
    ]);
  } finally {
    await broker.close();
    await rm(directory, { recursive: true, force: true });
  }
});
