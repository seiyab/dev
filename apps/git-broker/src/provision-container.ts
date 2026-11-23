import { provisionFromStdin } from "./provision-stdin.js";
import { BROKER_CREDENTIALS_DIR, BOX_CAPABILITY_DIR } from "./provision.js";

const options = process.argv.slice(2);
if (options.length > 1 || (options.length === 1 && options[0] !== "--rotate"))
  throw new Error("Usage: provision-container.js [--rotate]");
if (process.stdin.isTTY)
  throw new Error(
    "Redirect the App private key into stdin with docker compose run -T",
  );
try {
  const result = await provisionFromStdin(
    process.env,
    process.stdin,
    {
      credentialsDir: BROKER_CREDENTIALS_DIR,
      capabilityDir: BOX_CAPABILITY_DIR,
    },
    options[0] === "--rotate",
  );
  console.log(
    `Provisioned box ${result.boxId} in Docker-managed named volumes.\nNo files were written to host directories. Start or restart git-broker to load the policy.`,
  );
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
