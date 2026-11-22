import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitHubApp } from "../src/github.js";
import { brokerGit, type GitRunner } from "../src/git.js";
import { provisionMountedBroker } from "../src/provision-mounted.js";
import { provisionGitHubBroker } from "../src/provision.js";
import { createUpstreams } from "../src/upstreams.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
const repository = { id: "demo/repo", repositoryId: 7, installationId: 99 };
const token = "ghs_APPID_" + "long-token-format".repeat(10);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "box-github-test-"));
  const key = join(directory, "app.pem");
  await writeFile(key, pem, { mode: 0o600 });
  return {
    directory,
    key,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

test("GitHub JWT signatures, narrow scopes, token caching, refresh and invalidation", async () => {
  const f = await fixture();
  try {
    let now = Date.UTC(2026, 10, 22);
    let mints = 0;
    const calls: { url: string; headers: Headers }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, headers });
      assert.equal(init?.redirect, "error");
      if (url.endsWith("/access_tokens")) {
        assert.equal(
          url,
          "https://api.github.com/app/installations/99/access_tokens",
        );
        const jwt = headers.get("authorization")!.slice(7);
        const [header, payload, signature] = jwt.split(".");
        assert.ok(
          verify(
            "RSA-SHA256",
            Buffer.from(header + "." + payload),
            pair.publicKey,
            Buffer.from(signature, "base64url"),
          ),
        );
        assert.equal(
          JSON.parse(Buffer.from(header, "base64url").toString()).alg,
          "RS256",
        );
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
        assert.equal(claims.iss, "Iv1.example");
        assert.equal(claims.iat, Math.floor(now / 1000) - 60);
        assert.ok(claims.exp <= Math.floor(now / 1000) + 600);
        const body = JSON.parse(init!.body as string);
        assert.deepEqual(body.permissions, { contents: "write" });
        assert.equal(body.repository_ids.length, 1);
        assert.ok([7, 8].includes(body.repository_ids[0]));
        mints++;
        return Response.json({
          token,
          expires_at: new Date(now + 3_600_000).toISOString(),
          permissions: { contents: "write", metadata: "read" },
        });
      }
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      if (url.endsWith("/7"))
        return Response.json({ id: 7, full_name: "demo/repo", private: false });
      assert.equal(url, "https://api.github.com/repositories/8");
      return Response.json({ id: 8, full_name: "demo/other", private: false });
    };
    const app = new GitHubApp("Iv1.example", f.key, fetcher, () => now);
    assert.deepEqual(
      await Promise.all([app.token(repository), app.token(repository)]),
      [token, token],
    );
    assert.equal(mints, 1);
    now += 3_481_000;
    await Promise.all([app.token(repository), app.token(repository)]);
    assert.equal(mints, 2);
    await app.token({ ...repository, id: "demo/other", repositoryId: 8 });
    assert.equal(mints, 3);
    app.invalidate(repository);
    await app.token(repository);
    assert.equal(mints, 4);
    assert.equal(calls.length, 8);
  } finally {
    await f.close();
  }
});

test("GitHub repository mismatches, private repositories, broad tokens, and failures fail closed without secret output", async () => {
  const f = await fixture();
  try {
    const make = (fetcher: typeof fetch) =>
      new GitHubApp("123", f.key, fetcher);
    const mint = (
      permissions: Record<string, string> = { contents: "write" },
    ) =>
      Response.json({
        token,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions,
      });
    for (const info of [
      { id: 8, full_name: "demo/repo", private: false },
      { id: 7, full_name: "someone/else", private: false },
      { id: 7, full_name: "demo/repo", private: true },
    ]) {
      const app = make(async (input) =>
        String(input).endsWith("access_tokens") ? mint() : Response.json(info),
      );
      await assert.rejects(app.token(repository), /identity.*or.*private/);
    }
    const broad = make(async () =>
      mint({ contents: "write", workflows: "write" }),
    );
    await assert.rejects(broad.token(repository), /overly broad/);
    for (const fetcher of [
      (async () =>
        Response.json({ message: token }, { status: 403 })) as typeof fetch,
      (async () => {
        throw new Error("redirect or network error: " + token);
      }) as typeof fetch,
      (async () => Response.json(null)) as typeof fetch,
    ]) {
      await assert.rejects(
        make(fetcher).token(repository),
        (error) => error instanceof Error && !error.message.includes(token),
      );
    }
  } finally {
    await f.close();
  }
});

test("Git credentials are scoped to the configured upstream and never command arguments or object parsing", async () => {
  let issued = 0;
  let invalidated = 0;
  let fail = false;
  const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const run: GitRunner = async (_file, args, options) => {
    seen.push({ args, env: options.env });
    if (fail) throw new Error("transport failed");
    return { stdout: "" };
  };
  const url = "https://github.com/demo/repo.git";
  const git = brokerGit(
    "/tmp",
    {
      url,
      token: async () => {
        issued++;
        return token;
      },
      invalidate: () => {
        invalidated++;
      },
    },
    run,
  );
  await git(["bundle", "unbundle", "/tmp/incoming.bundle"]);
  await git(["fsck", "--strict"]);
  assert.equal(issued, 0);
  assert.equal(seen[0].env.GIT_CONFIG_COUNT, undefined);
  await git(["ls-remote", "--refs", url]);
  assert.equal(issued, 1);
  const call = seen.at(-1)!;
  assert.equal(call.env.GIT_CONFIG_KEY_0, `http.${url}.extraHeader`);
  assert.equal(
    call.env.GIT_CONFIG_VALUE_0,
    `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  );
  assert.ok(!call.args.join(" ").includes(token));
  assert.ok(call.args.includes("http.followRedirects=false"));
  assert.ok(call.args.includes("credential.helper="));
  assert.equal(call.env.GIT_TRACE_CURL, undefined);
  await git(["init", "--bare", "/tmp/another.git"]);
  assert.equal(seen.at(-1)!.env.GIT_CONFIG_COUNT, undefined);
  fail = true;
  await assert.rejects(git(["push", url, "HEAD:refs/heads/box/demo/topic"]));
  assert.equal(invalidated, 1);
});

test("provisioning separates policy and App key from the box capability, preserves identity and supports rotation", async () => {
  const f = await fixture();
  try {
    const destination = join(f.directory, "private");
    const input = {
      boxId: "local",
      appId: "123",
      privateKeyFile: f.key,
      repositories: [repository],
    };
    provisionGitHubBroker(input, destination);
    const policyText = await readFile(join(destination, "policy.json"), "utf8");
    const policy = JSON.parse(policyText);
    const capability = await readFile(
      join(destination, "box-capability"),
      "utf8",
    );
    assert.match(capability.trim(), /^[0-9a-f]{64}$/);
    assert.ok(!policyText.includes(capability.trim()));
    assert.ok(!policyText.includes("PRIVATE KEY"));
    assert.equal(policy.boxes[0].capabilityFile, "/run/secrets/box-capability");
    assert.equal(
      policy.githubApp.privateKeyFile,
      "/run/secrets/github-app-key",
    );
    assert.equal((await stat(destination)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(join(destination, "github-app.pem"))).mode & 0o777,
      0o444,
    );
    provisionGitHubBroker(input, destination);
    assert.equal(
      await readFile(join(destination, "box-capability"), "utf8"),
      capability,
    );
    provisionGitHubBroker(input, destination, true);
    assert.notEqual(
      await readFile(join(destination, "box-capability"), "utf8"),
      capability,
    );
    provisionGitHubBroker({ ...input, repositories: [] }, destination);
    assert.deepEqual(
      JSON.parse(await readFile(join(destination, "policy.json"), "utf8"))
        .boxes[0].repositories,
      [],
    );
    assert.throws(
      () =>
        provisionGitHubBroker({ ...input, boxId: "someone-else" }, destination),
      /different box identity/,
    );
    await assert.rejects(
      createUpstreams({
        ...policy,
        stateDir: f.directory,
        githubApp: { appId: "123", privateKeyFile: f.key },
        repositories: [{ id: "demo/repo", upstream: f.directory }],
      }),
      /cannot be mixed/,
    );
  } finally {
    await f.close();
  }
});

test("real Git receives the scoped auth header and refuses redirects", async () => {
  let requests = 0;
  let authorization: string | undefined;
  const server = createServer((request, response) => {
    requests++;
    authorization = request.headers.authorization;
    response.writeHead(301, { Location: "/redirected" });
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/repo.git`;
  const execute = promisify(execFile);
  try {
    const runner: GitRunner = async (file, args, options) =>
      execute(file, args, {
        ...options,
        // Test-only HTTP listener; production upstream creation permits only GitHub HTTPS.
        env: { ...options.env, GIT_ALLOW_PROTOCOL: "file:http" },
      });
    const git = brokerGit(
      "/tmp",
      { url, token: async () => token, invalidate: () => {} },
      runner,
    );
    await assert.rejects(git(["ls-remote", "--refs", url]));
    assert.equal(requests, 1);
    assert.equal(
      authorization,
      `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("mounted provisioning uses the explicitly mounted key and output, preserves capability, and rotates", async () => {
  const f = await fixture();
  try {
    const input = join(f.directory, "input.json");
    const output = join(f.directory, "output");
    await writeFile(
      input,
      JSON.stringify({
        boxId: "docker",
        appId: "123",
        repositories: [repository],
        privateKeyFile: "/unmounted/host/path.pem",
        destination: "/unmounted/output",
      }),
    );
    provisionMountedBroker(input, f.key, output);
    assert.equal(await readFile(join(output, "github-app.pem"), "utf8"), pem);
    const capability = await readFile(join(output, "box-capability"), "utf8");
    provisionMountedBroker(input, f.key, output);
    assert.equal(
      await readFile(join(output, "box-capability"), "utf8"),
      capability,
    );
    provisionMountedBroker(input, f.key, output, true);
    assert.notEqual(
      await readFile(join(output, "box-capability"), "utf8"),
      capability,
    );
    const policy = JSON.parse(
      await readFile(join(output, "policy.json"), "utf8"),
    );
    assert.equal(policy.boxes[0].id, "docker");
    assert.equal(
      policy.githubApp.privateKeyFile,
      "/run/secrets/github-app-key",
    );
  } finally {
    await f.close();
  }
});
