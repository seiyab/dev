import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const cli = resolve("apps/git-broker/bin/box");
test("box gh pr create derives Git context, passes options and emits URL or JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "box-cli-"));
  const capability = "a".repeat(64);
  const requests: unknown[] = [];
  const result = {
    number: 7,
    url: "https://github.com/demo/repo/pull/7",
    created: true,
  };
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/v1/repos/demo/repo/pulls");
    assert.equal(req.headers.authorization, "Bearer " + capability);
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(result));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const capabilityFile = join(directory, "capability");
    await writeFile(capabilityFile, capability);
    await writeFile(join(directory, "body.md"), "A multiline\nPR body\n");
    const options = {
      cwd: directory,
      env: {
        ...process.env,
        BOX_BROKER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        BOX_CAPABILITY_FILE: capabilityFile,
      },
    };
    const git = (...args: string[]) => exec("git", args, options);
    await git("init", "-b", "box/local/topic");
    await git("remote", "add", "origin", "https://github.com/other/repo.git");
    await git("remote", "add", "publish", "box::demo/repo");
    await git("config", "remote.pushDefault", "publish");
    const args = [
      "gh",
      "pr",
      "create",
      "--title",
      "A title",
      "--body-file",
      "body.md",
      "--base",
      "release",
      "--draft",
    ];
    assert.equal((await exec(cli, args, options)).stdout.trim(), result.url);
    assert.deepEqual(requests[0], {
      head: "box/local/topic",
      title: "A title",
      body: "A multiline\nPR body\n",
      base: "release",
      draft: true,
    });
    assert.deepEqual(
      JSON.parse((await exec(cli, [...args, "--json"], options)).stdout),
      result,
    );
    await assert.rejects(
      exec(cli, [...args, "--unknown"], options),
      /Unknown option/,
    );
    await git("config", "branch.box/local/topic.pushRemote", "origin");
    await assert.rejects(exec(cli, args, options), /box::OWNER\/REPO/);
    assert.equal(requests.length, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
