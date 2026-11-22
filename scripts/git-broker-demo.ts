import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  newCapability,
  startGitBroker,
} from "../apps/git-broker/src/server.js";

const directory = await mkdtemp(join(tmpdir(), "box-git-demo-"));
const upstream = join(directory, "upstream.git");
const seed = join(directory, "seed");
const checkout = join(directory, "checkout");
const capabilityFile = join(directory, "box-capability");
await writeFile(capabilityFile, newCapability(), { mode: 0o600 });
const exec = promisify(execFile);
const git = async (args: string[], cwd = directory) =>
  exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Box Demo",
      GIT_AUTHOR_EMAIL: "box@example.invalid",
      GIT_COMMITTER_NAME: "Box Demo",
      GIT_COMMITTER_EMAIL: "box@example.invalid",
    },
  });
await mkdir(seed);
await git(["init", "--object-format=sha1", "-b", "main"], seed);
await writeFile(join(seed, "README.md"), "# Local broker demo\n");
await git(["add", "."], seed);
await git(["commit", "-m", "Initialize demo"], seed);
await git(["clone", "--bare", seed, upstream]);
await git(["clone", upstream, checkout]);
await git(["config", "user.name", "Box Demo"], checkout);
await git(["config", "user.email", "box@example.invalid"], checkout);
await git(
  ["config", "remote.origin.pushurl", "box::demo/repository"],
  checkout,
);
await git(["switch", "-c", "box/demo/topic"], checkout);
const configuration = {
  port: 0,
  stateDir: join(directory, "broker-state"),
  repositories: [{ id: "demo/repository", upstream }],
  boxes: [{ id: "demo", capabilityFile, repositories: ["demo/repository"] }],
};
await writeFile(
  join(directory, "broker.json"),
  JSON.stringify(configuration, null, 2) + "\n",
  { mode: 0o600 },
);
const broker = await startGitBroker(configuration);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
console.log(`Credential-free broker demo: ${broker.url}
In another terminal:

export PATH=${quote(resolve("apps/git-broker/bin"))}:"$PATH"
export BOX_BROKER_URL=${quote(broker.url)}
export BOX_CAPABILITY_FILE=${quote(capabilityFile)}
cd ${quote(checkout)}
printf '\\nA change\\n' >> README.md
git commit -am 'Demo change'
git push -u origin HEAD
# Make another commit, then use ordinary git push or lazygit's P binding.
# git push origin HEAD:main is rejected by the broker.

Stop with Ctrl-C. Demo files remain at ${directory}; no GitHub account or tokens are used.`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void broker.close();
  });
