import { resolve } from "node:path";
import { startBridge } from "./api/server.js";

const port = Number(process.env.WORKBENCH_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid port");
const bridge = startBridge({
  hostname: process.env.WORKBENCH_HOST ?? "127.0.0.1",
  port,
  origin: process.env.WORKBENCH_ORIGIN ?? `http://localhost:${port}`,
  stateDir: resolve(process.env.WORKBENCH_STATE_DIR ?? ".workbench"),
  workspaceDir: resolve(process.env.WORKBENCH_WORKSPACE_DIR ?? "workspace"),
  webRoot: resolve(process.env.WORKBENCH_WEB_ROOT ?? "../web/dist"),
  shell: process.env.WORKBENCH_SHELL ?? "/bin/bash",
  tmuxSocket: process.env.WORKBENCH_TMUX_SOCKET ?? "workbench",
});
console.log(
  `Workbench listening on ${process.env.WORKBENCH_ORIGIN ?? `http://localhost:${port}`}`,
);
console.log("Read the access-key file in WORKBENCH_STATE_DIR to sign in.");
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void bridge.close().then(() => process.exit(0));
  });
}
