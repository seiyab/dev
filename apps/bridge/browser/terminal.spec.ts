import { test, expect, type Page } from "@playwright/test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { startBridge } from "../src/api/server.js";

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

test("shell exit closes its pane and persists the empty layout after the last exit", async ({
  page,
}) => {
  await command(page, "export SURVIVOR=alive");
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  await command(page, "exit");
  await expect(page.locator("[data-pane-id]")).toHaveCount(1);
  await command(page, "echo SURVIVOR_$SURVIVOR");
  await expect(page.locator(".xterm-rows")).toContainText("SURVIVOR_alive");
  await command(page, "exit");
  await expect(page.locator("[data-pane-id]")).toHaveCount(0);
  await expect(page.locator("[data-layout-status]")).toContainText(
    "Layout saved",
  );
  await page.reload();
  await expect(page.locator("[data-pane-id]")).toHaveCount(0);
});

test("queued layout mutations use each preceding save's revision", async ({
  page,
}) => {
  const revisions: number[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/layout", async (route) => {
    revisions.push(route.request().postDataJSON().revision);
    if (revisions.length === 1) await held;
    await route.continue();
  });
  try {
    await prefix(page, "%");
    await expect.poll(() => revisions.length).toBe(1);
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
    await prefix(page, "z");
    await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
    const refreshed = page.waitForResponse("**/api/workspace");
    await prefix(page, "d");
    await refreshed;
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
    await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
    await page.keyboard.press("Escape");
    expect(revisions).toHaveLength(1);
  } finally {
    release();
  }
  await saved(page);
  expect(revisions).toHaveLength(2);
  expect(revisions[1]).toBe(revisions[0]! + 1);
  await page.reload();
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
});

test("signing in after session expiry loads a fresh workspace", async ({
  page,
  context,
}) => {
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await saved(page);
  await context.clearCookies();
  await page
    .getByRole("button", { name: "Detached terminals", exact: true })
    .click();
  await expect(page.getByLabel("Access key")).toBeVisible();
  await page
    .getByLabel("Access key")
    .fill(readFileSync(join(dir, "access-key"), "utf8").trim());
  await page.getByRole("button", { name: "Open terminal" }).click();
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(page.locator("[data-pane-id] footer [role=status]")).toHaveText([
    "Connected",
    "Connected",
  ]);
  await prefix(page, "z");
  await saved(page);
  await expect(page.locator("[data-pane-id]:visible")).toHaveCount(1);
});

test("terminal mutations update the query cache even when invalidation refetches fail", async ({
  page,
}) => {
  let failNextRefresh = true;
  let refreshes = 0;
  await page.route("**/api/workspace", async (route) => {
    refreshes++;
    if (failNextRefresh) {
      failNextRefresh = false;
      await route.fulfill({
        status: 503,
        body: "Workspace refresh unavailable",
      });
    } else {
      await route.continue();
    }
  });
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  await saved(page);
  expect(refreshes).toBe(1);
  await prefix(page, "x");
  await saved(page);
  await prefix(page, "d");
  const terminate = page.getByRole("button", { name: /^Terminate Terminal/ });
  await expect(terminate).toBeVisible();
  await expect.poll(() => refreshes).toBe(2);
  failNextRefresh = true;
  await terminate.click();
  await expect(terminate).toHaveCount(0);
  await expect.poll(() => refreshes).toBe(3);
  await expect(
    page.getByText("No detached terminals.", { exact: false }),
  ).toBeVisible();
  await expect(page.locator("[data-pane-id]")).toHaveCount(1);
});

async function createSession(page: Page, name: string, directory: string) {
  await prefix(page, "p");
  await page
    .getByRole("button", { name: "Create session", exact: true })
    .click();
  await page.getByLabel("Session name").fill(name);
  await page.getByLabel("Working directory").fill(directory);
  await page
    .getByRole("button", { name: "Create session", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
}
async function switchSession(page: Page, name: string) {
  await prefix(page, "s");
  await page
    .getByRole("button", { name: `Switch to ${name}`, exact: false })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test("session picker supports keyboard navigation, search, and creation", async ({
  page,
}) => {
  await prefix(page, "s");
  const picker = page.getByRole("dialog");
  const original = picker.getByRole("button", { name: /^Switch to Default/ });
  await expect(original).toBeFocused();
  await page.keyboard.press("n");
  const name = picker.getByLabel("Session name");
  await expect(name).toBeFocused();
  await name.fill("jnk");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);

  await prefix(page, "s");
  const created = picker.getByRole("button", { name: /^Switch to jnk/ });
  await expect(created).toBeFocused();
  await page.keyboard.press("k");
  await expect(original).toBeFocused();
  await page.keyboard.press("j");
  await expect(created).toBeFocused();
  await page.keyboard.press("/");
  const filter = picker.getByRole("textbox", { name: "Filter sessions" });
  await expect(filter).toBeFocused();
  await page.keyboard.type("jnk");
  await expect(filter).toHaveValue("jnk");
  await expect(original).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(created).toBeFocused();
  await page.keyboard.press("/");
  await expect(filter).toBeFocused();
  await page.keyboard.press("Control+[");
  await expect(created).toBeFocused();
  await page.keyboard.press("Control+[");
  await expect(picker).toHaveCount(0);
  await prefix(page, "s");
  await page.keyboard.press("/");
  await filter.fill("Default");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await prefix(page, "s");
  await expect(original).toBeFocused();
});

test("directory sessions preserve independent shells, layouts, and selection", async ({
  page,
}) => {
  mkdirSync(join(dir, "project"));
  await command(page, "export SESSION_MARKER=original");
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await saved(page);
  await createSession(page, "Project", "project");
  await command(page, "printf 'DIRECTORY_%s\\n' \"$PWD\"");
  await expect(page.locator(".xterm-rows")).toContainText(
    `DIRECTORY_${join(dir, "project")}`,
  );
  await command(page, "export SESSION_MARKER=project");
  await prefix(page, "%");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await expect(
    page.locator("[data-active='true']").getByRole("status"),
  ).toHaveText("Connected");
  await command(page, "pwd");
  await expect(page.locator("[data-active='true'] .xterm-rows")).toContainText(
    join(dir, "project"),
  );
  await prefix(page, "x");
  await saved(page);
  await switchSession(page, "Default");
  await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  await prefix(page, "d");
  await expect(page.getByRole("dialog")).toContainText("No detached terminals");
  await page.keyboard.press("Escape");
  await prefix(page, "h");
  await command(page, "echo MARKER_$SESSION_MARKER");
  await expect(page.locator("[data-active='true'] .xterm-rows")).toContainText(
    "MARKER_original",
  );
  await switchSession(page, "Project");
  await expect(page.locator("[data-pane-id]")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
  await command(page, "echo MARKER_$SESSION_MARKER");
  await expect(page.locator(".xterm-rows")).toContainText("MARKER_project");
  await prefix(page, "d");
  await expect(
    page.getByRole("dialog").getByRole("button", { name: /Reopen Terminal/ }),
  ).toHaveCount(1);
});

test("sessions can be renamed, archived, reopened, and explicitly deleted", async ({
  page,
}) => {
  await command(
    page,
    "export SESSION_MARKER=survives_archive; touch session-file",
  );
  await prefix(page, "s");
  await page
    .getByRole("button", { name: "Rename Default", exact: true })
    .click();
  await page.getByLabel("Session name").fill("Renamed");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await prefix(page, "s");
  await page
    .getByRole("button", { name: "Archive Renamed", exact: true })
    .click();
  await expect(page.locator("[data-pane-id]")).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Choose a work session" }),
  ).toBeVisible();
  await prefix(page, "s");
  await expect(
    page.getByRole("button", { name: /Reopen Renamed/ }),
  ).toHaveCount(0);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Show archived sessions" }).click();
  await page.getByRole("button", { name: /Reopen Renamed/ }).click();
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
  await command(page, "echo MARKER_$SESSION_MARKER");
  await expect(page.locator(".xterm-rows")).toContainText(
    "MARKER_survives_archive",
  );
  await prefix(page, "s");
  await page
    .getByRole("button", { name: "Delete Renamed", exact: true })
    .click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Delete Renamed", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete session and terminate terminals" })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("[data-pane-id]")).toHaveCount(0);
  const state = await (
    await page.request.get("http://127.0.0.1:3173/api/workspace")
  ).json();
  expect(state.sessions).toEqual([]);
  expect(state.terminals).toEqual([]);
  expect(state.selectedSessionId).toBeNull();
  expect(existsSync(join(dir, "session-file"))).toBe(true);
  expect(() =>
    execFileSync("tmux", ["-L", tmuxSocket, "has-session", "-t", "=terminal"], {
      stdio: "ignore",
    }),
  ).toThrow();
  await createSession(page, "Fresh", ".");
});

test("switching sessions waits for queued layout saves", async ({ page }) => {
  await createSession(page, "Other", ".");
  await switchSession(page, "Default");
  await expect(page.locator("[data-pane-id]").getByRole("status")).toHaveText(
    "Connected",
  );
  let release!: () => void;
  let saving = false;
  let switching = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/layout", async (route) => {
    saving = true;
    await held;
    await route.continue();
  });
  page.on("request", (request) => {
    if (request.url().endsWith("/api/sessions")) switching = true;
  });
  try {
    await prefix(page, "%");
    await expect.poll(() => saving).toBe(true);
    await prefix(page, "s");
    await page.getByRole("button", { name: /Switch to Other/ }).click();
    await expect(
      page.getByRole("button", { name: /Switch to Other/ }),
    ).toBeDisabled();
    expect(switching).toBe(false);
    release();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await switchSession(page, "Default");
    await expect(page.locator("[data-pane-id]")).toHaveCount(2);
  } finally {
    release();
  }
});
