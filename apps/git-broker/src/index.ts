import { readFileSync } from "node:fs";
import { startGitBroker, type BrokerConfig } from "./server.js";

const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: node apps/git-broker/dist/index.js /absolute/path/to/config.json",
  );
const broker = await startGitBroker(
  JSON.parse(readFileSync(file, "utf8")) as BrokerConfig,
);
console.log(`Local Git broker prototype listening at ${broker.url}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void broker.close();
  });
}
