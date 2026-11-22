export type RepositoryGrant =
  | { id: string; upstream: string; github?: never }
  | {
      id: string;
      github: { repositoryId: number; installationId: number };
      upstream?: never;
    };

export interface BrokerConfig {
  port: number;
  hostname?: "127.0.0.1" | "0.0.0.0";
  allowedHost?: string;
  stateDir: string;
  githubApp?: { appId: string; privateKeyFile: string };
  repositories: RepositoryGrant[];
  boxes: { id: string; capabilityFile: string; repositories: string[] }[];
}
