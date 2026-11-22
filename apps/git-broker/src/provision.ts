import { createPrivateKey, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { BrokerConfig } from "./config.js";
import { isRepositoryId } from "./protocol.js";

interface ProvisionInput {
  boxId: string;
  appId: string;
  privateKeyFile: string;
  repositories: { id: string; repositoryId: number; installationId: number }[];
}
export function provisionGitHubBroker(
  input: ProvisionInput,
  destination: string,
  rotate = false,
) {
  if (
    !input ||
    typeof input.boxId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.boxId) ||
    !["string", "number"].includes(typeof input.appId) ||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(String(input.appId)) ||
    typeof input.privateKeyFile !== "string" ||
    !isAbsolute(input.privateKeyFile) ||
    !Array.isArray(input.repositories) ||
    input.repositories.some(
      (r) =>
        !r ||
        !isRepositoryId(r.id) ||
        !Number.isSafeInteger(r.repositoryId) ||
        r.repositoryId < 1 ||
        !Number.isSafeInteger(r.installationId) ||
        r.installationId < 1,
    ) ||
    new Set(input.repositories.map((r) => r.id)).size !==
      input.repositories.length ||
    new Set(input.repositories.map((r) => r.repositoryId)).size !==
      input.repositories.length
  )
    throw new Error(
      "Invalid provisioning input: supply a box ID, App ID, private-key path, and explicit repository/installation IDs",
    );
  const privateKey = readFileSync(input.privateKeyFile);
  if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa")
    throw new Error("GitHub App key must be RSA");
  const directory = resolve(destination);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = statSync(directory);
  if (
    (directoryStat.mode & 0o077) !== 0 ||
    (process.getuid && directoryStat.uid !== process.getuid())
  )
    throw new Error(
      "Provisioning directory must be owned by you and have mode 0700",
    );
  const policyFile = join(directory, "policy.json");
  if (existsSync(policyFile)) {
    const previous = JSON.parse(
      readFileSync(policyFile, "utf8"),
    ) as BrokerConfig;
    if (previous.boxes.length !== 1 || previous.boxes[0].id !== input.boxId)
      throw new Error(
        "Use a different provisioning directory for a different box identity",
      );
  }
  const capabilityFile = join(directory, "box-capability");
  const capability =
    !rotate && existsSync(capabilityFile)
      ? readFileSync(capabilityFile, "utf8").trim()
      : randomBytes(32).toString("hex");
  if (!/^[0-9a-f]{64}$/.test(capability))
    throw new Error("Invalid existing capability; explicitly rotate it");
  const policy: BrokerConfig = {
    hostname: "0.0.0.0",
    allowedHost: "git-broker:3180",
    port: 3180,
    stateDir: "/home/node/.git-broker",
    githubApp: {
      appId: String(input.appId),
      privateKeyFile: "/run/secrets/github-app-key",
    },
    repositories: input.repositories.map((r) => ({
      id: r.id,
      github: {
        repositoryId: r.repositoryId,
        installationId: r.installationId,
      },
    })),
    boxes: [
      {
        id: input.boxId,
        capabilityFile: "/run/secrets/box-capability",
        repositories: input.repositories.map((r) => r.id),
      },
    ],
  };
  function replace(name: string, content: string | Buffer) {
    const temporary = join(
      directory,
      name + "." + randomBytes(8).toString("hex") + ".tmp",
    );
    // Compose file-backed secrets preserve file modes. The private parent protects
    // host access; read-only files let the non-root container user read its mount.
    writeFileSync(temporary, content, { mode: 0o444, flag: "wx", flush: true });
    renameSync(temporary, join(directory, name));
  }
  replace("github-app.pem", privateKey);
  replace("box-capability", capability + "\n");
  replace("policy.json", JSON.stringify(policy, null, 2) + "\n");
  return { directory, boxId: input.boxId };
}
