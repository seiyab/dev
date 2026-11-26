# Development workbench

A local, keyboard-first development workbench with tiled browser terminals
backed by node-pty and independent tmux sessions inside a development container.
See [DESIGN.md](DESIGN.md) for the agreed architecture and later milestones.

## Run with Docker Desktop

```sh
docker compose -f compose.workbench.yaml up --build -d
docker compose -f compose.workbench.yaml exec workbench cat /home/node/.workbench/access-key
```

Open **http://localhost:3000**, then enter the access key. Use this exact hostname:
the bridge checks Host and Origin. The key is generated on first startup and kept
in a named volume; it is never printed in application logs. Anyone with the key
can obtain a terminal in this workspace. Do not share it or place it in a URL.

Reloading or closing the browser preserves the layout and running shells through
tmux. Disconnect detaches without ending a shell. A second browser connection to
the same terminal is refused while it is controlled; disconnect the first before
reconnecting in the second. Typing `exit` ends the shell; use **Recreate** to start
a new one. Container restart also ends running processes; saved panes remain and
offer explicit recreation. Browser authentication expires after twelve hours and
is reset when the bridge restarts.

## Panes and keyboard controls

Each named work session has a working directory, pane layout, and its own terminal
resources. Click a pane to focus it; its green border indicates where ordinary
keyboard input goes. Splits create new terminals in the session's directory. Each
terminal has its own shell and tmux session. Splitting, resizing, and zooming preserve existing terminal views
and processes.

Press **Ctrl-g**, release it, then press a command key:

| Key                   | Action                                           |
| --------------------- | ------------------------------------------------ |
| `%`                   | Split left/right                                 |
| `"`                   | Split top/bottom                                 |
| `h` / `j` / `k` / `l` | Focus left/down/up/right without wrapping        |
| `H` / `J` / `K` / `L` | Move a split boundary, entering resize mode      |
| `z`                   | Zoom the active pane or restore the layout       |
| `x`                   | Close the pane and keep its terminal             |
| `d`                   | Open the detached-terminal picker                |
| `s`                   | Switch or manage work sessions                   |
| `p` / `?`             | Open the command palette and binding help        |
| `Ctrl-g`              | Send a literal Ctrl-g to the focused application |
| `Escape`              | Cancel the pending command or leave resize mode  |

In resize mode, repeat `h/j/k/l` until Escape. Resize acts on the closest enclosing
split of the requested orientation, moving its boundary in five-percent steps.
The prefix prompt shows available bindings; invalid commands are swallowed with
visible feedback. IME composition and browser/OS shortcuts are left alone in
normal typing mode. Losing browser focus clears the pending prefix/resize mode.
Toolbar buttons and the command palette invoke the same actions as shortcuts.

Manually closing a pane keeps its terminal running. Reopen it from **Detached
terminals**, even after closing the last pane or reloading the browser. Exiting
its shell automatically closes the pane; the work session remains, even when its
last shell exits. Start a new terminal to get another shell. The picker also offers
**Terminate**, which ends a detached terminal and removes its resource. Use
Disconnect to release control without removing a pane. Hidden panes stay
connected while another is zoomed.

Layout, focus, zoom, split ratios, and terminal identities are stored in versioned
`workspace.json` in the state volume. Wait for **Layout saved** before closing the
browser immediately after changing the layout. Writes use atomic replacement and
revision checks: concurrent layout edits are rejected with a reload message.
There is a limit of 16 panes per session, 64 sessions, and 64 terminal resources
across all sessions; terminate unused detached terminals to free resources. The original prototype's terminal is reused
when workspace metadata is first created.

## Work sessions

Use **Ctrl-g s** to switch or manage sessions. Use **Create session** in the command
palette (**Ctrl-g p**) or session picker to supply a name and an existing directory.
In the picker, press **k** or **j** to move up or down and **Enter** to open the
focused session. Press **/** to search and **n** to open the create form.
From search, **Enter** opens the first match. **Escape** or **Ctrl-[** returns to
the list from search and closes the picker from the list.
Relative directories resolve from the configured workspace root (`/home/node/workspace`
in Compose); absolute directories must also be inside that root. The workbench
does not create directories or Git worktrees. New terminals start in this directory;
existing shells retain their current directories.

Switching saves pending layout edits before detaching the previous session's
views. Shells keep running, and switching back restores its layout and focus.
The selected session is restored on reload. Detached-terminal pickers only show
terminals belonging to the current session.

The session picker offers rename, archive, and delete. **Archive** hides a session
from the normal list while preserving its shells and layout. Choose **Show archived
sessions**, then **Reopen**, to restore it. **Delete** asks for confirmation, terminates
all of that session's terminals (including detached ones), and removes its metadata.
It leaves project files intact. Archiving or deleting the selected session switches
to another unarchived session, or shows an empty session chooser if none remain.

Existing workspace metadata is automatically migrated to version 2 as a **Default**
session, preserving terminal IDs and layout. All sessions share the container and
filesystem; they provide organization rather than isolation. Session and layout
edits share revision checks, so conflicting edits from another browser require reload.

```sh
docker compose -f compose.workbench.yaml down
```

This preserves the project, workbench state, Codex, and Neovim data volumes. Do not add `--volumes`
unless you intend to delete that data.

The prototype uses separate volumes and configuration from the original
`compose.yaml`. It does not mount your host projects, SSH agent, agent
credentials, or Docker socket. It runs as a non-root user with dropped Linux
capabilities and no privilege escalation. It includes Zsh, Bash, Git, tmux, Neovim,
lazygit, and Codex CLI, plus the Neovim configuration described below. Outbound
network access is available; this is not an egress sandbox.

## Container tools

New workbench terminals open in Zsh with vi editing enabled. Press **Escape**
for command mode and **i** to return to insert mode. The prompt shows the
current directory and the Git branch, or the short commit ID when HEAD is
detached. Shell history is shared across panes and persists in the workbench
state volume across container restarts and rebuilds.

The workbench image includes pinned releases of
[Neovim 0.12.6](https://github.com/neovim/neovim/releases/tag/v0.12.6),
[lazygit 0.66.3](https://github.com/jesseduffield/lazygit/releases/tag/v0.66.3), and
[Codex CLI](https://github.com/openai/codex) (`@openai/codex@0.171.0`). The Neovim
and lazygit archives are SHA-256 checked for both arm64 and amd64. Git's default
editor inside the container is `nvim`.

`/home/node/.config/nvim` is a checkout of [seiyab/nv](https://github.com/seiyab/nv),
pinned to `7a7e3830290bf2b7805de2d0a9cbfa76bee18327`. Its plugin manager installs
plugins on first launch; allow network access while that completes. Language
servers and other external tools are managed by the configuration's Mason setup.
The Neovim data volume preserves lazy.nvim, its installed plugins, and Mason
downloads across container recreation. The image supplies the Neovim configuration.
To use a different config commit, rebuild with `docker compose -f compose.workbench.yaml build
--build-arg NVIM_CONFIG_REVISION=<commit>`, then start the updated image.

After rebuilding the image, run `nvim`, `lazygit`, or `codex` from a workbench
terminal. For Codex authentication, run `codex login --device-auth` inside the
container. The Codex volume preserves container-local login credentials, session
history, and settings across container recreation. Use `codex resume` to reopen a
saved session. The image provides box-wide Codex guidance through
`~/.codex/AGENTS.md`. Update [workbench/AGENTS.md](workbench/AGENTS.md) and rebuild
the image to change that guidance.

The image also supplies a Codex permission profile under `/etc/codex`. It allows
workspace edits and network access without command approval prompts. Sandboxed
commands are denied reads of Codex's login file, session transcripts and history,
the workbench access key, and the terminal control socket. The profile inherits
Codex's workspace protections for metadata
such as `.git`. The Git helper still has access to the broker capability when
GitHub publishing is configured.

After rebuilding and signing in to Codex, verify the sandbox from a workbench
terminal. The check tests readability without displaying any credential contents:

```sh
(
  set -e
  credential=/home/node/.codex/auth.json
  test -r "$credential"
  codex sandbox linux -- sh -ec '
    test ! -r "$1"
    scratch=$(mktemp /home/node/workspace/sandbox-probe.XXXXXX)
    rm -- "$scratch"
  ' sh "$credential"
)
```

If sandbox startup fails, check the Docker runtime's namespace support and its
seccomp and AppArmor logs before changing the workbench's security options.

## Git publishing

Use [GitHub publishing setup](apps/git-broker/GITHUB.md) to enable scoped pushes
to selected public repositories through a separate GitHub App broker. Provisioning
and startup run through Docker Compose; the App key enters through stdin and
provisioning outputs stay in separate Docker-managed named volumes. No writable
host bind mounts or host Node, pnpm, Git, or build toolchains are required. The default workbench still starts without GitHub credentials.
Use `box gh pr create --title "Describe the change" --body-file ./pr-description.md`
after pushing an owned branch. See the setup guide for App permissions and base-branch policy.

An optional [local prototype for contributors](apps/git-broker/README.md) exercises
Git and lazygit against a test upstream without GitHub credentials. Its pnpm
commands are for repository development, not normal workbench setup.

## Local development

Install the Node version in `.node-version`, pnpm 10.34.9, tmux, a shell, and the
node-pty build prerequisites (Python 3, make, and a C++ compiler on Linux).

```sh
pnpm install --frozen-lockfile
WORKBENCH_ORIGIN=http://localhost:5173 pnpm dev
```

Open http://localhost:5173. Read `apps/bridge/.workbench/access-key` to sign in.
The Vite server proxies API and WebSocket requests to the bridge on port 3000.
The local shell runs as your current user: use Compose for container isolation.
Local terminal working files live in `apps/bridge/workspace`, which is ignored.

To run the production build locally:

```sh
pnpm build
pnpm start
```

Open http://localhost:3000, using the same access key file. `WORKBENCH_HOST`,
`WORKBENCH_PORT`, `WORKBENCH_ORIGIN`, `WORKBENCH_STATE_DIR`,
`WORKBENCH_WORKSPACE_DIR`, `WORKBENCH_WEB_ROOT`, `WORKBENCH_SHELL`, and
`WORKBENCH_TMUX_SOCKET` configure the bridge. Relative paths resolve from the
bridge process's working directory. The origin must be a single exact origin,
without a trailing slash. Do not expose the bridge on a network interface
without an appropriately secured deployment.

## Checks

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:browser
```

The local Oxlint rule `ecq/filter-keys` requires `ecq.keyOf(factory)` instead of
`factory().queryKey` in non-exact query filters, including invalidation, removal,
refetch, and cancellation. It recognizes local `ecq.query`/`ecq.client` factories
and imports from the `queryModules` configured in `oxlint.config.ts`. Exact cache
reads/writes, filters with `exact: true`, and factory calls with arguments stay
unchanged. `pnpm exec oxlint --fix apps packages` fixes violations when an
unshadowed ECQ import is available. Rule integration tests run with `pnpm test`.

`workbench/prefer-mutation-context-client` warns when an explicitly typed
`QueryClient` parameter is used only inside callbacks of directly returned
`mutationOptions(...)`. Prefer the callbacks' `context.client` in that case.
The rule leaves parameters used elsewhere alone and provides no autofix: changing
factory signatures and callers, or intentionally targeting another query client,
requires review.

Backend integration tests create temporary tmux servers and exercise real PTYs,
authentication, upgrade rejection, independent terminals, layout validation and
revision conflicts, bridge restart, explicit recreation, resize, reconnect, and
high-output flow control. Browser tests use the production frontend and verify
keyboard splits, focus, resizing, zoom, prefix passthrough, reload persistence,
detached terminals, directory sessions, archive/reopen/delete, and an unsaved nvim buffer. Browser tests require nvim.

Multiple tabs, worktree integration, mouse-drag resizing, configurable bindings,
controller takeover, PWA installation, and scoped GitHub publishing are later
increments.
The existing container and Git scripts remain unchanged.
