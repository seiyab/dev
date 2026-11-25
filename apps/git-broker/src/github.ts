import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { PullRequestRequest } from "./protocol.js";
import { BrokerError } from "./protocol.js";

type GitHubRepository = {
  id: string;
  repositoryId: number;
  installationId: number;
  baseBranches?: string[];
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
        `GitHub App request denied (${response.status}); check installation access and Contents / Pull requests permissions`,
        502,
      );
    try {
      return await response.json();
    } catch {
      throw new BrokerError("Invalid GitHub App response", 502);
    }
  }
  private async mint(
    repository: GitHubRepository,
    pullRequests = false,
  ): Promise<Token> {
    const permission = pullRequests ? "pull_requests" : "contents";
    const result = await this.api(
      `/app/installations/${repository.installationId}/access_tokens`,
      this.jwt(),
      {
        repository_ids: [repository.repositoryId],
        permissions: { [permission]: "write" },
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
      result.permissions?.[permission] !== "write" ||
      (result.permissions.metadata !== undefined &&
        result.permissions.metadata !== "read") ||
      Object.keys(result.permissions).some(
        (p) => ![permission, "metadata"].includes(p),
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
  async createPullRequest(
    repository: GitHubRepository,
    request: PullRequestRequest,
  ) {
    // PR authority is minted separately; Git transport tokens remain Contents-only.
    const { token } = await this.mint(repository, true);
    const path = `/repos/${repository.id}`;
    const owner = repository.id.split("/")[0];
    const find = async () => {
      const result = await this.api(
        `${path}/pulls?state=open&head=${encodeURIComponent(owner + ":" + request.head)}&per_page=100`,
        token,
      );
      if (!Array.isArray(result))
        throw new BrokerError("Invalid GitHub PR response", 502);
      return result.find(
        (pr) =>
          pr.head?.ref === request.head &&
          pr.head?.repo?.id === repository.repositoryId &&
          pr.base?.repo?.id === repository.repositoryId,
      );
    };
    const info = await this.api(
      `/repositories/${repository.repositoryId}`,
      token,
    );
    const base = request.base ?? info?.default_branch;
    const allowed = repository.baseBranches ?? [info?.default_branch];
    if (typeof base !== "string" || !allowed.includes(base))
      throw new BrokerError(
        "PR base branch is not allowed by the repository grant",
        403,
      );
    let pr = await find();
    let created = false;
    if (!pr) {
      try {
        pr = await this.api(path + "/pulls", token, {
          title: request.title,
          body: request.body,
          head: request.head,
          base,
          draft: request.draft,
        });
        created = true;
      } catch (error) {
        // Reconcile a racing create or a response lost after GitHub accepted it.
        pr = await find();
        if (!pr) throw error;
      }
    }
    if (!created && (!allowed.includes(pr.base?.ref) || pr.base?.ref !== base))
      throw new BrokerError(
        "An open PR already exists for this head with a different or disallowed base",
        409,
      );
    if (
      !Number.isSafeInteger(pr.number) ||
      pr.number < 1 ||
      pr.html_url !== `https://github.com/${repository.id}/pull/${pr.number}`
    )
      throw new BrokerError("Invalid GitHub PR response", 502);
    return { number: pr.number as number, url: pr.html_url as string, created };
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
