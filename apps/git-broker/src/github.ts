import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BrokerError } from "./protocol.js";

type GitHubRepository = {
  id: string;
  repositoryId: number;
  installationId: number;
};
interface Token {
  token: string;
  expiresAt: number;
}

/** App keys, JWTs and installation tokens stay inside the broker trust boundary. */
export class GitHubApp {
  private readonly key;
  private readonly cache = new Map<string, Promise<Token>>();
  constructor(
    private readonly appId: string,
    privateKeyFile: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (
      typeof appId !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(appId) ||
      typeof privateKeyFile !== "string" ||
      !isAbsolute(privateKeyFile)
    )
      throw new Error("Invalid GitHub App configuration");
    this.key = createPrivateKey(readFileSync(privateKeyFile));
    if (this.key.asymmetricKeyType !== "rsa")
      throw new Error("GitHub App key must be an RSA private key");
  }
  private jwt() {
    const now = Math.floor(this.now() / 1000);
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
    return (
      payload +
      "." +
      sign("RSA-SHA256", Buffer.from(payload), this.key).toString("base64url")
    );
  }
  private async api(path: string, authorization: string, body?: unknown) {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.github.com${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "workbench-git-broker",
          Authorization: `Bearer ${authorization}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BrokerError(
        "GitHub App request failed; check broker connectivity and App configuration",
        502,
      );
    }
    if (!response.ok)
      throw new BrokerError(
        `GitHub App request denied (${response.status}); check installation access and Contents permission`,
        502,
      );
    try {
      return await response.json();
    } catch {
      throw new BrokerError("Invalid GitHub App response", 502);
    }
  }
  private async mint(repository: GitHubRepository): Promise<Token> {
    const result = await this.api(
      `/app/installations/${repository.installationId}/access_tokens`,
      this.jwt(),
      {
        repository_ids: [repository.repositoryId],
        permissions: { contents: "write" },
      },
    );
    const expiresAt = Date.parse(result?.expires_at);
    if (
      !result ||
      typeof result.token !== "string" ||
      !/^[\x21-\x7e]{20,8192}$/.test(result.token) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now() + 120_000 ||
      expiresAt > this.now() + 7_200_000 ||
      result.permissions?.contents !== "write" ||
      (result.permissions.metadata !== undefined &&
        result.permissions.metadata !== "read") ||
      Object.keys(result.permissions).some(
        (p) => !["contents", "metadata"].includes(p),
      )
    )
      throw new BrokerError(
        "GitHub returned an invalid or overly broad installation token",
        502,
      );
    const info = await this.api(
      `/repositories/${repository.repositoryId}`,
      result.token,
    );
    if (
      info?.id !== repository.repositoryId ||
      info.full_name !== repository.id ||
      info.private !== false
    )
      throw new BrokerError(
        "GitHub repository identity does not match its grant, or the repository is private",
        403,
      );
    return { token: result.token, expiresAt };
  }
  private cacheKey(repository: GitHubRepository) {
    return `${repository.installationId}:${repository.repositoryId}:${repository.id}`;
  }
  invalidate(repository: GitHubRepository) {
    this.cache.delete(this.cacheKey(repository));
  }
  async token(repository: GitHubRepository): Promise<string> {
    const key = this.cacheKey(repository);
    let entry = this.cache.get(key);
    if (entry) {
      const cached = await entry;
      if (cached.expiresAt > this.now() + 120_000) return cached.token;
      if (this.cache.get(key) === entry) this.cache.delete(key);
      return this.token(repository);
    }
    entry = this.mint(repository);
    this.cache.set(key, entry);
    try {
      return (await entry).token;
    } catch (error) {
      if (this.cache.get(key) === entry) this.cache.delete(key);
      throw error;
    }
  }
}
