import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function createTmux(socket: string) {
  const run = promisify(execFile);
  return {
    socket,
    async running(id: string) {
      try {
        await run("tmux", ["-L", socket, "has-session", "-t", `=${id}`]);
        return true;
      } catch {
        return false;
      }
    },
    async kill(id: string) {
      await run("tmux", ["-L", socket, "kill-session", "-t", `=${id}`]);
    },
  };
}
