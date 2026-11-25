import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { brokerClient } from "./client.js";
import { isRepositoryId } from "./protocol.js";

const usage =
  "Usage: box gh pr create --title TITLE [--body-file PATH] [--base BRANCH] [--draft] [--json]";
const execute = promisify(execFile);
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(usage);
    return;
  }
  if (args.splice(0, 3).join(" ") !== "gh pr create") throw new Error(usage);
  let title: string | undefined;
  let bodyFile: string | undefined;
  let base: string | undefined;
  let draft = false;
  let json = false;
  const seen = new Set<string>();
  while (args.length) {
    const option = args.shift()!;
    if (option === "--help" || option === "-h") {
      console.log(usage);
      return;
    }
    if (seen.has(option)) throw new Error("Repeated option: " + option);
    seen.add(option);
    if (option === "--draft") draft = true;
    else if (option === "--json") json = true;
    else if (["--title", "--body-file", "--base"].includes(option)) {
      const value = args.shift();
      if (!value || value.startsWith("--"))
        throw new Error("Missing value for " + option);
      if (option === "--title") title = value;
      else if (option === "--body-file") bodyFile = value;
      else base = value;
    } else throw new Error("Unknown option: " + option);
  }
  if (!title?.trim()) throw new Error(usage);
  const git = async (...parameters: string[]) =>
    (
      await execute("git", parameters, {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      })
    ).stdout.trim();
  let head: string;
  try {
    head = await git("symbolic-ref", "--quiet", "--short", "HEAD");
  } catch {
    throw new Error("Check out a branch before creating a PR");
  }
  // Git's push-remote precedence: branch override, pushDefault, tracking remote, origin.
  const config = async (key: string) => {
    try {
      return await git("config", "--get", key);
    } catch {
      return "";
    }
  };
  const remote =
    (await config(`branch.${head}.pushRemote`)) ||
    (await config("remote.pushDefault")) ||
    (await config(`branch.${head}.remote`)) ||
    "origin";
  const urls = (
    await git("remote", "get-url", "--push", "--all", remote)
  ).split("\n");
  if (
    urls.length !== 1 ||
    !urls[0].startsWith("box::") ||
    !isRepositoryId(urls[0].slice(5))
  )
    throw new Error(
      "The selected push remote must have one box::OWNER/REPO URL",
    );
  const body = bodyFile ? await readFile(bodyFile, "utf8") : "";
  const result = await brokerClient(urls[0].slice(5))("/pulls", {
    head,
    title,
    body,
    base,
    draft,
  });
  console.log(json ? JSON.stringify(result) : result.url);
}
main().catch((error: unknown) => {
  console.error(
    "box: " + (error instanceof Error ? error.message : "Command failed"),
  );
  process.exitCode = 1;
});
