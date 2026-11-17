# Development workbench

A local, keyboard-first development workbench. The first slice provides one
browser terminal backed by node-pty and tmux inside a development container.
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

Reloading or closing the browser preserves the running shell through tmux.
Disconnect detaches without ending it. A second browser connection is refused
while the terminal is controlled; disconnect the first before reconnecting in
the second. Typing `exit` ends the shell; Reconnect starts a new shell. A container
restart also ends running processes. Browser authentication expires after twelve
hours and is reset when the bridge restarts.

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
authentication, upgrade rejection, resize, reconnect, and high-output flow
control. Browser tests use the production frontend and verify sign-in, terminal
input, viewport resizing, and reload persistence.

Split panes, prefix bindings, saved layouts, multiple workspaces, controller
takeover, PWA installation, and scoped GitHub publishing are later increments.
The existing container and Git scripts remain unchanged.
