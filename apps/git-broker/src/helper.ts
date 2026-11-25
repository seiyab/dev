import { brokerClient } from "./client.js";
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
const request = brokerClient(repository);
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
