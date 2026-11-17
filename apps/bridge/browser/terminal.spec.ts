import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { startBridge } from "../src/server.js";

let bridge: ReturnType<typeof startBridge>;
let dir: string;
let tmuxSocket: string;
let errors: string[];

test.beforeEach(async ({ page }) => {
  dir = mkdtempSync(join(tmpdir(), "wb-browser-"));
  tmuxSocket = `wb-browser-${process.pid}`;
  bridge = startBridge({
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
  errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:3173");
  await page
    .getByLabel("Access key")
    .fill(readFileSync(join(dir, "access-key"), "utf8").trim());
  await page.getByRole("button", { name: "Open terminal" }).click();
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
});
test.afterEach(async ({ page }) => {
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
  expect(errors).toEqual([]);
});
async function command(page: Page, text: string) {
  await page.locator("[data-active='true'] .xterm-helper-textarea").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
async function prefix(page: Page, key: string) {
  await page.keyboard.press("Control+g");
  await page.keyboard.press(key);
}
async function saved(page: Page) {
  await expect(page.locator("[data-layout-status]")).toContainText(
    "Layout saved",
  );
}

test("sign in, type, resize, reload, and detach a persistent shell", async ({
  page,
}, testInfo) => {
  await command(
    page,
    "export WB_BROWSER=preserved; printf 'BROWSER_%s\\n' ready",
  );
  await expect(page.locator(".xterm-rows")).toContainText("BROWSER_ready");
  await page.setViewportSize({ width: 800, height: 600 });
  await command(page, "stty size");
  await expect(page.locator(".xterm-rows")).toContainText(/\d+ \d+/);
  await page.reload();
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
  await command(page, "printf 'RELOAD_%s\\n' \"$WB_BROWSER\"");
  await expect(page.locator(".xterm-rows")).toContainText("RELOAD_preserved");
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(
    page.locator("[data-pane-id]").getByRole("status"),
  ).toContainText("shell is still running");
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
  await page.screenshot({ path: testInfo.outputPath("terminal.png") });
});

test("keyboard splits preserve independent shells, focus, resize, zoom, and saved layout", async ({
  page,
}, testInfo) => {
  const firstId = await page
    .locator("[data-active='true']")
    .getAttribute("data-pane-id");
  const first = page.locator(`[data-pane-id="${firstId}"]`);
  await command(page, "export WB_PANE=first");
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  const secondId = await page
    .locator("[data-active='true']")
    .getAttribute("data-pane-id");
  await command(page, "export WB_PANE=second");
  await prefix(page, "h");
  await expect(first).toHaveAttribute("data-active", "true");
  await expect(first.locator("textarea")).toBeFocused();
  await command(page, "printf 'PANE_%s\\n' \"$WB_PANE\"");
  await expect(first.locator(".xterm-rows")).toContainText("PANE_first");
  const originalWidth = (await first.boundingBox())!.width;
  await prefix(page, "L");
  await expect(page.locator("[data-layout-status]")).toContainText(
    "Resize mode",
  );
  await expect
    .poll(async () => (await first.boundingBox())!.width)
    .toBeGreaterThan(originalWidth);
  const wider = (await first.boundingBox())!.width;
  await page.keyboard.press("l");
  await expect
    .poll(async () => (await first.boundingBox())!.width)
    .toBeGreaterThan(wider);
  await page.keyboard.press("Escape");
  await prefix(page, "l");
  await expect(page.locator("[data-active='true']")).toHaveAttribute(
    "data-pane-id",
    secondId!,
  );
  await prefix(page, '"');
  await expect(page.locator("[data-pane-id]")).toHaveCount(3);
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  await prefix(page, "k");
  await expect(page.locator("[data-active='true']")).toHaveAttribute(
    "data-pane-id",
    secondId!,
  );
  await command(page, "printf 'PANE_%s\\n' \"$WB_PANE\"");
  await expect(page.locator("[data-active='true'] .xterm-rows")).toContainText(
    "PANE_second",
  );
  await prefix(page, "z");
  await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  await prefix(page, "z");
  await expect(page.locator("[data-pane-id]:visible")).toHaveCount(3);
  await saved(page);
  const ids = await page
    .locator("[data-pane-id]")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-pane-id")));
  await page.reload();
  await expect(page.locator("[data-pane-id]")).toHaveCount(3);
  await expect(page.locator("[data-pane-id] footer [role=status]")).toHaveText([
    "Connected",
    "Connected",
    "Connected",
  ]);
  expect(
    await page
      .locator("[data-pane-id]")
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-pane-id"))),
  ).toEqual(ids);
  await expect(page.locator("[data-active='true']")).toHaveAttribute(
    "data-pane-id",
    secondId!,
  );
  expect((await first.boundingBox())!.width).toBeGreaterThan(originalWidth);
  await page.screenshot({ path: testInfo.outputPath("panes.png") });
  // Capture Ctrl-g in a shell builtin to verify literal passthrough and swallowing invalid commands.
  await command(page, `IFS= read -rsn1 key; printf 'KEY_%d\\n' "'$key"`);
  await prefix(page, "q");
  await expect(page.locator("[data-layout-status]")).toContainText(
    "Unknown workbench command",
  );
  await prefix(page, "Control+g");
  await expect(page.locator("[data-active='true'] .xterm-rows")).toContainText(
    "KEY_7",
  );
});

test("closing and reopening panes preserves their terminals, including closing the last pane", async ({
  page,
}) => {
  await command(page, "export WB_DETACHED=alive");
  await prefix(page, "x");
  await expect(page.locator("[data-pane-id]")).toHaveCount(0);
  await saved(page);
  await prefix(page, "d");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("textbox").press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
  await command(page, "printf 'DETACHED_%s\\n' \"$WB_DETACHED\"");
  await expect(page.locator(".xterm-rows")).toContainText("DETACHED_alive");
  await prefix(page, "?");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-active='true'] textarea")).toBeFocused();
});

test("nvim keeps an unsaved buffer across splits and browser reload", async ({
  page,
}) => {
  await command(page, "nvim --clean -n");
  await expect(page.locator("[data-active='true'] .xterm-rows")).toContainText(
    "NVIM",
  );
  await page.keyboard.press("i");
  await page.keyboard.type("workbench-unsaved-buffer");
  await page.keyboard.press("Escape");
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  await prefix(page, "h");
  await expect(page.locator("[data-active='true'] .xterm-rows")).toContainText(
    "workbench-unsaved-buffer",
  );
  await saved(page);
  await page.reload();
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  await expect(page.locator("[data-active='true'] .xterm-rows")).toContainText(
    "workbench-unsaved-buffer",
  );
  await page.keyboard.type(":q!");
  await page.keyboard.press("Enter");
  await expect(
    page.locator("[data-active='true'] .xterm-rows"),
  ).not.toContainText("workbench-unsaved-buffer");
});

test("a layout conflict preserves the saved layout and keeps local focus accurate", async ({
  page,
}) => {
  const state = await (
    await page.request.get("http://127.0.0.1:3173/api/workspace")
  ).json();
  const external = await page.request.put("http://127.0.0.1:3173/api/layout", {
    headers: { Origin: "http://127.0.0.1:3173" },
    data: { revision: state.revision, layout: state.layout },
  });
  expect(external.status()).toBe(200);
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(page.locator("[data-layout-status]")).toContainText(
    "Layout not saved",
  );
  const first = page.locator('[data-pane-id="terminal"]');
  await first.locator("textarea").focus();
  await expect(first).toHaveAttribute("data-active", "true");
  await page.keyboard.type("printf 'FOCUS_%s\\n' correct");
  await page.keyboard.press("Enter");
  await expect(first.locator(".xterm-rows")).toContainText("FOCUS_correct");
  const persisted = await (
    await page.request.get("http://127.0.0.1:3173/api/workspace")
  ).json();
  expect(persisted.layout).toEqual(state.layout);
});

test("an ended terminal can be recreated with its keyboard handle intact", async ({
  page,
}) => {
  await command(page, "export OLD_SESSION=previous; exit");
  await page.getByRole("button", { name: "Recreate", exact: true }).click();
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
  await command(page, "printf 'RECREATED_%s\\n' \"${OLD_SESSION:-fresh}\"");
  await expect(page.locator(".xterm-rows")).toContainText("RECREATED_fresh");
  await command(page, `IFS= read -rsn1 key; printf 'KEY_%d\\n' "'$key"`);
  await prefix(page, "Control+g");
  await expect(page.locator(".xterm-rows")).toContainText("KEY_7");
});
