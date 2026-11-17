import { build } from "../apps/bridge/node_modules/esbuild/lib/main.js";

await build({
  entryPoints: ["apps/bridge/src/index.ts"],
  absWorkingDir: new URL("..", import.meta.url).pathname,
  outfile: "apps/bridge/dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "hono",
    "hono/*",
    "@hono/node-server",
    "@hono/node-server/*",
    "node-pty",
    "ws",
  ],
});
