import { readFileSync } from "node:fs";
import { provisionGitHubBroker } from "./provision.js";

/** The container's explicit mounts, not input JSON paths, select key and output. */
export function provisionMountedBroker(
  inputFile: string,
  privateKeyFile: string,
  directory: string,
  rotate = false,
) {
  const input = JSON.parse(readFileSync(inputFile, "utf8"));
  return provisionGitHubBroker({ ...input, privateKeyFile }, directory, rotate);
}
