import { build } from "../apps/bridge/node_modules/esbuild/lib/main.js";

await build({
  absWorkingDir: new URL("..", import.meta.url).pathname,
  entryPoints: [
    "apps/git-broker/src/index.ts",
    "apps/git-broker/src/helper.ts",
  ],
  outdir: "apps/git-broker/dist",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["hono", "hono/*", "@hono/node-server", "@hono/node-server/*"],
});
