import { provisionGitHubBroker, type ProvisionOutputs } from "./provision.js";

/** Public settings use environment variables; the private key uses bounded stdin. */
export async function provisionFromStdin(
  env: NodeJS.ProcessEnv,
  stdin: AsyncIterable<Buffer | string>,
  outputs: ProvisionOutputs,
  rotate = false,
) {
  let repositories: unknown;
  try {
    repositories = JSON.parse(env.GITHUB_REPOSITORIES ?? "[]");
  } catch {
    throw new Error(
      "GITHUB_REPOSITORIES must be a JSON array of repository grants",
    );
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("Private-key input exceeds 64 KiB");
    chunks.push(buffer);
  }
  if (!size) throw new Error("Supply the GitHub App private key through stdin");
  return provisionGitHubBroker(
    {
      boxId: env.BOX_ID ?? "local",
      appId: env.GITHUB_APP_ID ?? "",
      repositories,
    } as Parameters<typeof provisionGitHubBroker>[0],
    Buffer.concat(chunks),
    outputs,
    rotate,
  );
}
