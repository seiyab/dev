import { readFileSync } from "node:fs";

export function brokerClient(repository: string) {
  const base = new URL(process.env.BOX_BROKER_URL ?? "");
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "git-broker"].includes(base.hostname) ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  )
    throw new Error(
      "BOX_BROKER_URL must be an HTTP origin on 127.0.0.1 or git-broker",
    );
  const capabilityFile = process.env.BOX_CAPABILITY_FILE;
  if (!capabilityFile) throw new Error("BOX_CAPABILITY_FILE is required");
  const capability = readFileSync(capabilityFile, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(capability))
    throw new Error("Invalid box capability file");
  const endpoint = `${base.origin}/v1/repos/${repository}`;
  return async function request(path: string, value?: unknown) {
    const response = await fetch(endpoint + path, {
      method: value === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${capability}`,
        "Content-Type": "application/json",
      },
      body: value === undefined ? undefined : JSON.stringify(value),
      redirect: "error",
      signal: AbortSignal.timeout(path === "/pulls" ? 120_000 : 30_000),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };
}
