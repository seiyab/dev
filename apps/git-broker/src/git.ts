import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BrokerError,
  isOid,
  type PushRequest,
  type RemoteRef,
} from "./protocol.js";

const exec = promisify(execFile);

/** Broker Git never inherits developer Git configuration, hooks, or credentials. */
export function brokerGit(home: string) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  return async (args: string[], cwd = home) => {
    const result = await exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "init.templateDir=", ...args],
      {
        cwd,
        env,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return result.stdout.trim();
  };
}
export type BrokerGit = ReturnType<typeof brokerGit>;

export async function remoteRefs(
  git: BrokerGit,
  upstream: string,
): Promise<RemoteRef[]> {
  const output = await git(["ls-remote", "--refs", upstream]);
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [oid, name] = line.split("\t");
    if (!isOid(oid) || !name?.startsWith("refs/"))
      throw new Error("Invalid upstream refs");
    return { oid, name };
  });
}

/** A fresh bare repository imports objects without using caller-supplied config. */
export async function preparePush(
  git: BrokerGit,
  stateDir: string,
  upstream: string,
  request: PushRequest,
) {
  const directory = await mkdtemp(join(stateDir, "incoming-"));
  const repository = join(directory, "repo.git");
  const bundle = join(directory, "incoming.bundle");
  try {
    await git(["init", "--bare", "--object-format=sha1", repository]);
    if (request.expectedOid) {
      await git(
        ["fetch", "--no-tags", upstream, `${request.ref}:refs/box/previous`],
        repository,
      );
      if (
        (await git(["rev-parse", "refs/box/previous"], repository)) !==
        request.expectedOid
      )
        throw new BrokerError("Upstream changed; fetch and retry", 409);
    }
    await writeFile(bundle, Buffer.from(request.bundle, "base64"), {
      mode: 0o600,
    });
    try {
      await git(["bundle", "verify", bundle], repository);
      await git(["bundle", "unbundle", bundle], repository);
      if (
        (await git(["cat-file", "-t", request.newOid], repository)) !== "commit"
      )
        throw new Error();
      await git(
        ["update-ref", "refs/box/proposed", request.newOid],
        repository,
      );
      await git(
        ["fsck", "--strict", "--no-reflogs", "--no-dangling"],
        repository,
      );
    } catch {
      throw new BrokerError("Invalid bundle or proposed commit");
    }
    if (request.expectedOid) {
      try {
        await git(
          ["merge-base", "--is-ancestor", request.expectedOid, request.newOid],
          repository,
        );
      } catch {
        throw new BrokerError("History rewrites are not permitted", 403);
      }
    }
    return {
      push: async () => {
        try {
          // A lease closes the race after our independent fast-forward check.
          await git(
            [
              "push",
              "--porcelain",
              `--force-with-lease=${request.ref}:${request.expectedOid ?? ""}`,
              upstream,
              `${request.newOid}:${request.ref}`,
            ],
            repository,
          );
        } catch {
          throw new BrokerError(
            "Upstream rejected the push or its outcome is uncertain; fetch before retrying",
            502,
          );
        }
      },
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Runs only inside the development checkout, without any broker authority. */
export async function createBundle(source: string) {
  const { tmpdir } = await import("node:os");
  const { randomUUID } = await import("node:crypto");
  const directory = await mkdtemp(join(tmpdir(), "box-bundle-"));
  const ref = `refs/box-upload/${randomUUID()}`;
  let oid: string | undefined;
  try {
    oid = (
      await exec("git", [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${source}^{commit}`,
      ])
    ).stdout.trim();
    if (!isOid(oid)) throw new Error("Only SHA-1 commit pushes are supported");
    await exec("git", [
      "-c",
      "core.hooksPath=/dev/null",
      "update-ref",
      ref,
      oid,
    ]);
    const file = join(directory, "outgoing.bundle");
    await exec("git", ["bundle", "create", file, ref], { timeout: 20_000 });
    const data = await readFile(file);
    return { oid, data };
  } finally {
    if (oid)
      await exec("git", [
        "-c",
        "core.hooksPath=/dev/null",
        "update-ref",
        "-d",
        ref,
        oid,
      ]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
