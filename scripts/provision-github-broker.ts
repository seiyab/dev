import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { provisionGitHubBroker } from "../apps/git-broker/src/provision.js";

const [input, directory, option] = process.argv.slice(2);
if (!input || !directory || (option && option !== "--rotate"))
  throw new Error(
    "Usage: pnpm broker:provision /path/to/input.json /private/output/directory [--rotate]",
  );
// Resolve existing parent symlinks before ensuring secrets stay outside the build context.
const destination = resolve(directory);
let parent = destination;
while (!existsSync(parent)) parent = dirname(parent);
const actualDestination = resolve(
  realpathSync(parent),
  relative(parent, destination),
);
const fromRepository = relative(
  realpathSync(fileURLToPath(new URL("..", import.meta.url))),
  actualDestination,
);
if (
  fromRepository === "" ||
  (!fromRepository.startsWith("../") &&
    fromRepository !== ".." &&
    !isAbsolute(fromRepository))
)
  throw new Error("Choose a secrets directory outside this repository");
const result = provisionGitHubBroker(
  JSON.parse(readFileSync(input, "utf8")),
  directory,
  option === "--rotate",
);
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
console.log(`Provisioned broker policy and secrets for box ${result.boxId}.
Run on your Docker Desktop host:

export WORKBENCH_BROKER_DIR=${quote(result.directory)}
docker compose -f compose.workbench.yaml -f compose.github.yaml up --build --force-recreate -d

Inside a workbench terminal, configure an approved repository's push URL:
  git remote set-url --push origin box::OWNER/REPOSITORY
Public fetch remains on the existing GitHub HTTPS URL.
Recreate both services after updating grants or rotating secrets.`);
