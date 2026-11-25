import { build } from "../apps/git-broker/node_modules/esbuild/lib/main.js";

await build({
  absWorkingDir: new URL("..", import.meta.url).pathname,
  entryPoints: [
    "apps/git-broker/src/index.ts",
    "apps/git-broker/src/healthcheck.ts",
    "apps/git-broker/src/helper.ts",
    "apps/git-broker/src/provision-container.ts",
  ],
  outdir: "apps/git-broker/dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
});
