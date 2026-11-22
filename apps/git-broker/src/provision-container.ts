import { provisionMountedBroker } from "./provision-mounted.js";

const options = process.argv.slice(2);
if (options.length > 1 || (options.length === 1 && options[0] !== "--rotate"))
  throw new Error("Usage: provision-container.js [--rotate]");
const result = provisionMountedBroker(
  "/input/config.json",
  "/input/github-app.pem",
  "/output",
  options[0] === "--rotate",
);
console.log(`Provisioned broker policy and secrets for box ${result.boxId}.
The output is in your WORKBENCH_BROKER_DIR directory.
Recreate both workbench and broker services after changing grants or rotating secrets.`);
