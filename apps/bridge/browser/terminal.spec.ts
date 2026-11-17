import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { startBridge } from "../src/server.js";

test("sign in, type, resize, reload, and detach a persistent shell", async ({
  page,
}, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), "wb-browser-"));
  const tmuxSocket = `wb-browser-${process.pid}`;
  const bridge = startBridge({
    hostname: "127.0.0.1",
    port: 3173,
    origin: "http://127.0.0.1:3173",
    stateDir: dir,
    workspaceDir: dir,
    webRoot: resolve("apps/web/dist"),
    shell: "/bin/bash",
    tmuxSocket,
  });
  await once(bridge.server, "listening");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto("http://127.0.0.1:3173");
    await page
      .getByLabel("Access key")
      .fill(readFileSync(join(dir, "access-key"), "utf8").trim());
    await page.getByRole("button", { name: "Open terminal" }).click();
    await expect(page.getByRole("status")).toHaveText("Connected");
    const input = page.locator(".xterm-helper-textarea");
    await input.focus();
    await page.keyboard.type(
      "export WB_BROWSER=preserved; printf 'BROWSER_%s\\n' ready",
    );
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("BROWSER_ready");
    await page.setViewportSize({ width: 800, height: 600 });
    await input.focus();
    await page.keyboard.type("stty size");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(/\d+ \d+/);
    await page.reload();
    await expect(page.getByRole("status")).toHaveText("Connected");
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("printf 'RELOAD_%s\\n' \"$WB_BROWSER\"");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("RELOAD_preserved");
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(page.getByRole("status")).toContainText(
      "shell is still running",
    );
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Connected");
    await page.screenshot({ path: testInfo.outputPath("terminal.png") });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
    await bridge.close();
    try {
      execFileSync("tmux", ["-L", tmuxSocket, "kill-server"], {
        stdio: "ignore",
      });
    } catch {
      /* Already exited. */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
