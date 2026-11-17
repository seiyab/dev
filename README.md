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

The current workbench has one work session and one tab. Click a pane to focus it;
its green border indicates where ordinary keyboard input goes. Splits create
new terminals in the workspace directory. Each terminal has its own shell and
tmux session. Splitting, resizing, and zooming preserve existing terminal views
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
| `p` / `?`             | Open the command palette and binding help        |
| `Ctrl-g`              | Send a literal Ctrl-g to the focused application |
| `Escape`              | Cancel the pending command or leave resize mode  |

In resize mode, repeat `h/j/k/l` until Escape. Resize acts on the closest enclosing
split of the requested orientation, moving its boundary in five-percent steps.
The prefix prompt shows available bindings; invalid commands are swallowed with
visible feedback. IME composition and browser/OS shortcuts are left alone in
normal typing mode. Losing browser focus clears the pending prefix/resize mode.
Toolbar buttons and the command palette invoke the same actions as shortcuts.

Closing a pane never kills its terminal. Reopen it from **Detached terminals**,
even after closing the last pane or reloading the browser. The picker also offers
**Terminate**, which ends a detached terminal and removes its resource. Use
Disconnect to release control without removing a pane. Hidden panes stay
connected while another is zoomed.

Layout, focus, zoom, split ratios, and terminal identities are stored in versioned
`workspace.json` in the state volume. Wait for **Layout saved** before closing the
browser immediately after changing the layout. Writes use atomic replacement and
revision checks: concurrent layout edits are rejected with a reload message.
There is a limit of 16 visible panes and 64 terminal resources; terminate unused
detached terminals to free resources. The original prototype's terminal is reused
when workspace metadata is first created.

```sh
docker compose -f compose.workbench.yaml down
```

This preserves both project and authentication volumes. Do not add `--volumes`
unless you intend to delete that data.

The prototype uses separate volumes and configuration from the original
`compose.yaml`. It does not mount your host projects, SSH agent, agent
credentials, or Docker socket. It runs as a non-root user with dropped Linux
capabilities and no privilege escalation. It includes bash, Git, tmux, and
Neovim; your existing dotfiles and other tools are not migrated yet. Outbound
network access is available; this is not an egress sandbox.

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

Backend integration tests create temporary tmux servers and exercise real PTYs,
authentication, upgrade rejection, independent terminals, layout validation and
revision conflicts, bridge restart, explicit recreation, resize, reconnect, and
high-output flow control. Browser tests use the production frontend and verify
keyboard splits, focus, resizing, zoom, prefix passthrough, reload persistence,
detached terminals, and an unsaved nvim buffer. Browser tests require nvim.

Multiple tabs and work sessions, mouse-drag resizing, configurable bindings,
controller takeover, PWA installation, and scoped GitHub publishing are later
increments.
The existing container and Git scripts remain unchanged.
