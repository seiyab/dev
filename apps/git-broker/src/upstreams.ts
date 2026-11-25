import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { BrokerConfig } from "./config.js";
import { brokerGit, type BrokerGit } from "./git.js";
import { GitHubApp } from "./github.js";
import {
  type PullRequestRequest,
  isRepositoryId,
  validBaseBranches,
} from "./protocol.js";

export async function createUpstreams(config: BrokerConfig) {
  const app = config.githubApp
    ? new GitHubApp(config.githubApp.appId, config.githubApp.privateKeyFile)
    : undefined;
  const repositories = new Map<
    string,
    {
      url: string;
      git: BrokerGit;
      createPullRequest?: (
        request: PullRequestRequest,
      ) => Promise<{ number: number; url: string; created: boolean }>;
    }
  >();
  const localGit = brokerGit(config.stateDir);
  for (const repository of config.repositories) {
    if (
      !repository ||
      !isRepositoryId(repository.id) ||
      repositories.has(repository.id)
    )
      throw new Error("Invalid repository grant");
    let url: string;
    let git = localGit;
    if (repository.github) {
      if (
        !app ||
        repository.upstream !== undefined ||
        !Number.isSafeInteger(repository.github.repositoryId) ||
        repository.github.repositoryId < 1 ||
        !Number.isSafeInteger(repository.github.installationId) ||
        repository.github.installationId < 1 ||
        (repository.github.baseBranches !== undefined &&
          !validBaseBranches(repository.github.baseBranches))
      )
        throw new Error("Invalid GitHub repository grant");
      const identity = { id: repository.id, ...repository.github };
      url = `https://github.com/${repository.id}.git`;
      git = brokerGit(config.stateDir, {
        url,
        token: () => app.token(identity),
        invalidate: () => app.invalidate(identity),
      });
    } else {
      if (
        app ||
        typeof repository.upstream !== "string" ||
        !isAbsolute(repository.upstream)
      )
        throw new Error(
          "Local upstreams cannot be mixed with GitHub credentials",
        );
      url = realpathSync(repository.upstream);
      if (
        (await git(["--git-dir", url, "rev-parse", "--is-bare-repository"])) !==
          "true" ||
        (await git(["--git-dir", url, "rev-parse", "--show-object-format"])) !==
          "sha1"
      )
        throw new Error("Local upstreams must be SHA-1 bare repositories");
    }
    if ([...repositories.values()].some((r) => r.url === url))
      throw new Error("Repository aliases must not share an upstream");
    repositories.set(repository.id, {
      url,
      git,
      createPullRequest:
        repository.github && app
          ? (request) =>
              app.createPullRequest(
                { id: repository.id, ...repository.github! },
                request,
              )
          : undefined,
    });
  }
  return repositories;
}
