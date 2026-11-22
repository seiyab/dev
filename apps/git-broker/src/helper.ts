import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createBundle } from "./git.js";
import {
  isRepositoryId,
  MAX_BUNDLE_BYTES,
  type RemoteRef,
} from "./protocol.js";

const [, repository] = process.argv.slice(2);
if (!isRepositoryId(repository))
  throw new Error("Use a push URL such as box::owner/repository");
const base = new URL(process.env.BOX_BROKER_URL ?? "");
if (
  base.protocol !== "http:" ||
  base.hostname !== "127.0.0.1" ||
  base.username ||
  base.password ||
  base.pathname !== "/" ||
  base.search ||
  base.hash
)
  throw new Error(
    "Prototype BOX_BROKER_URL must be an http://127.0.0.1:port origin",
  );
const capabilityFile = process.env.BOX_CAPABILITY_FILE;
if (!capabilityFile) throw new Error("BOX_CAPABILITY_FILE is required");
const capability = readFileSync(capabilityFile, "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(capability))
  throw new Error("Invalid box capability file");
const endpoint = `${base.origin}/v1/repos/${repository}`;
async function request(path: string, value?: unknown) {
  const response = await fetch(endpoint + path, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${capability}`,
      "Content-Type": "application/json",
    },
    body: value === undefined ? undefined : JSON.stringify(value),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
const write = (message: string) => process.stdout.write(message);
const clean = (message: string) =>
  message.replace(/[\r\n\0]/g, " ").slice(0, 500);
let refs: RemoteRef[] | undefined;
let dryRun = false;
let batch: string[] = [];

async function push(commands: string[]) {
  const updates = commands.map((command) => {
    const match = /^push (\+?)([^:]*):(.+)$/.exec(command);
    if (!match) throw new Error("Invalid push command");
    return { source: match[2], ref: match[3] };
  });
  try {
    if (updates.length !== 1)
      throw new Error(
        "Prototype supports one branch update per push; multi-ref pushes are rejected",
      );
    const update = updates[0];
    if (!update.source) throw new Error("Branch deletion is not permitted");
    const { oid, data } = await createBundle(update.source);
    if (data.length > MAX_BUNDLE_BYTES)
      throw new Error("Bundle exceeds prototype size limit");
    refs ??= (await request("")).refs;
    await request("/push", {
      ref: update.ref,
      expectedOid: refs!.find((ref) => ref.name === update.ref)?.oid ?? null,
      newOid: oid,
      bundle: data.toString("base64"),
      dryRun,
    });
    write(`ok ${update.ref}\n\n`);
  } catch (error) {
    for (const update of updates)
      write(`error ${update.ref} ${clean((error as Error).message)}\n`);
    write("\n");
  }
}

try {
  for await (const line of createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  })) {
    if (line === "capabilities") write("push\noption\n\n");
    else if (line === "list" || line === "list for-push") {
      refs = (await request("")).refs;
      for (const ref of refs!) write(`${ref.oid} ${ref.name}\n`);
      write("\n");
    } else if (line.startsWith("option ")) {
      const [, name, value] = line.split(" ");
      if (name === "dry-run" && ["true", "false"].includes(value)) {
        dryRun = value === "true";
        write("ok\n");
      } else if (
        (["progress", "force"].includes(name) &&
          ["true", "false"].includes(value)) ||
        (name === "verbosity" && /^-?\d+$/.test(value))
      )
        write("ok\n");
      else write("unsupported\n");
    } else if (line.startsWith("push ")) batch.push(line);
    else if (line === "" && batch.length) {
      await push(batch);
      batch = [];
    } else if (line === "") break;
    else
      throw new Error(
        "Unsupported remote-helper operation; public fetch uses the normal origin URL",
      );
  }
} catch (error) {
  console.error(`box: ${clean((error as Error).message)}`);
  process.exitCode = 1;
}
