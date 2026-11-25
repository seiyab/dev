import { createPrivateKey, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { BrokerConfig } from "./config.js";
import { isRepositoryId, validBaseBranches } from "./protocol.js";

export const BROKER_CREDENTIALS_DIR = "/home/node/.broker-credentials";
export const BOX_CAPABILITY_DIR = "/home/node/.box-capability";
export interface ProvisionInput {
  boxId: string;
  appId: string;
  repositories: {
    id: string;
    repositoryId: number;
    installationId: number;
    baseBranches?: string[];
  }[];
}
export interface ProvisionOutputs {
  credentialsDir: string;
  capabilityDir: string;
}

export function provisionGitHubBroker(
  input: ProvisionInput,
  privateKey: Buffer,
  outputs: ProvisionOutputs,
  rotate = false,
) {
  if (
    !input ||
    typeof input.boxId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.boxId) ||
    !["string", "number"].includes(typeof input.appId) ||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(String(input.appId)) ||
    !Array.isArray(input.repositories) ||
    input.repositories.some(
      (r) =>
        !r ||
        !isRepositoryId(r.id) ||
        !Number.isSafeInteger(r.repositoryId) ||
        r.repositoryId < 1 ||
        !Number.isSafeInteger(r.installationId) ||
        r.installationId < 1 ||
        (r.baseBranches !== undefined && !validBaseBranches(r.baseBranches)),
    ) ||
    new Set(input.repositories.map((r) => r.id)).size !==
      input.repositories.length ||
    new Set(input.repositories.map((r) => r.repositoryId)).size !==
      input.repositories.length
  )
    throw new Error(
      "Invalid provisioning input: supply a box ID, App ID, and explicit repository/installation IDs",
    );
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa")
      throw new Error();
  } catch {
    throw new Error(
      "Expected an unencrypted GitHub App RSA private key on stdin",
    );
  }
  const credentialsDir = resolve(outputs.credentialsDir);
  const capabilityDir = resolve(outputs.capabilityDir);
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child);
    return (
      path === "" ||
      (path !== ".." && !path.startsWith("../") && !isAbsolute(path))
    );
  };
  if (
    contains(credentialsDir, capabilityDir) ||
    contains(capabilityDir, credentialsDir)
  )
    throw new Error(
      "Credential and capability directories must be separate and non-nested",
    );
  for (const directory of [credentialsDir, capabilityDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = statSync(directory);
    if (
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error(
        "Provisioning directories must be owned by the container user and have mode 0700",
      );
  }
  const policyFile = join(credentialsDir, "policy.json");
  if (existsSync(policyFile)) {
    const previous = JSON.parse(
      readFileSync(policyFile, "utf8"),
    ) as BrokerConfig;
    if (previous.boxes.length !== 1 || previous.boxes[0].id !== input.boxId)
      throw new Error(
        "Use different named volumes for a different box identity",
      );
  }
  const capabilityFile = join(capabilityDir, "box-capability");
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
      privateKeyFile: join(BROKER_CREDENTIALS_DIR, "github-app.pem"),
    },
    repositories: input.repositories.map((r) => ({
      id: r.id,
      github: {
        repositoryId: r.repositoryId,
        installationId: r.installationId,
        ...(r.baseBranches === undefined
          ? {}
          : { baseBranches: r.baseBranches }),
      },
    })),
    boxes: [
      {
        id: input.boxId,
        capabilityFile: join(BOX_CAPABILITY_DIR, "box-capability"),
        repositories: input.repositories.map((r) => r.id),
      },
    ],
  };
  function replace(directory: string, name: string, content: string | Buffer) {
    const temporary = join(
      directory,
      name + "." + randomBytes(8).toString("hex") + ".tmp",
    );
    writeFileSync(temporary, content, { mode: 0o400, flag: "wx", flush: true });
    renameSync(temporary, join(directory, name));
  }
  replace(credentialsDir, "github-app.pem", privateKey);
  replace(capabilityDir, "box-capability", capability + "\n");
  replace(
    credentialsDir,
    "policy.json",
    JSON.stringify(policy, null, 2) + "\n",
  );
  return { boxId: input.boxId };
}
