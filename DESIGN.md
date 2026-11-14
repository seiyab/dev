# Personal development workbench

Status: agreed direction for the first prototype.

## Intent

Build a personal, keyboard-first development workbench with tmux-like composition
and richer GUI panes. Keep existing terminal applications useful while migrating
individual workflows to GUI incrementally.

Development runs in Docker Compose on Docker Desktop on the user's computer.
Protecting the host and limiting credentials take priority; reproducible builds
also matter. Apple container framework support is outside scope.

## Architecture

```text
Browser SPA: Preact + xterm.js
               |
       authenticated WebSocket
               |
Development container:
  Hono terminal bridge -> node-pty -> tmux -> shell / TUI
```

The bridge runs as the development user inside its development container. It has
no Docker socket, host shell access, or GitHub credentials. The frontend owns the
visible pane layout; tmux preserves terminal processes across browser disconnects.

Serve built frontend assets and the bridge from one origin. During development,
use Vite's proxy for backend requests and WebSockets. Publish the bridge port on
host loopback only. Authenticate browser sessions and validate WebSocket origins
before accepting upgrades. Loopback binding alone is not authentication.

The bridge is inside the development trust boundary. Repository code can affect
it; it must not become a credential vault or a trusted Docker controller.
Authenticated operations and future container orchestration belong outside that
boundary.

## Stack and source layout

| Area | Choice |
| --- | --- |
| Frontend | Preact, Vite, xterm.js |
| Backend | Node.js, Hono with its Node WebSocket adapter, node-pty |
| Terminal persistence | tmux |
| Type checking | tsgo |
| Formatting | Prettier |
| Linting | Oxlint |
| Packages | pnpm workspaces and a committed lockfile |
| Runtime | Docker Compose on Docker Desktop |

```text
apps/web
apps/bridge
packages/protocol
```

Pin compatible runtime and dependency versions during implementation. Build
node-pty inside the target Linux image; do not mount host node_modules. Keep type
checking separate from frontend bundling. No database is required for v1.

## Work and layout model

A work session is a durable context for a task. It references a repository,
working directory, execution workspace, optional issue or PR, optional agent
conversations, terminal resources, and saved layout. It can exist before a PR or
agent conversation exists.

An execution workspace is the environment that runs code. Work sessions and
execution workspaces have separate identities. Sharing a container or using Git
worktrees provides organizational separation, not a security boundary.

The first prototype uses one execution workspace. When multiple workspaces are
introduced, default to a separate Compose project and project volume per
execution workspace.

The frontend hierarchy is work session -> tabs -> tiled panes. Each tab holds a
split tree with horizontal or vertical splits and leaf pane identifiers. Leaves
initially display terminals; later they can display first-party GUI components
or development previews.

Terminal resources have stable identities independent of the panes displaying
them. Initially, use one tmux session with one window and pane per terminal
resource. The frontend manages visible splits and tabs. Intentional nested tmux
usage remains possible through prefix passthrough.

## Keyboard and focus

Ordinary keys go to the focused application. There is no persistent global Vim
mode. Ctrl-g enters a temporary workbench command layer and is configurable.

| Binding after Ctrl-g | Action |
| --- | --- |
| h / j / k / l | Focus pane left / down / up / right |
| H / J / K / L | Enter repeatable resize interaction; Escape finishes |
| % | Split left/right |
| " | Split top/bottom |
| c | New tab |
| Ctrl-h / Ctrl-l | Previous / next tab |
| z | Toggle focused pane zoom |
| p | Command palette |
| s | Work-session picker |
| ? | Binding help |
| Ctrl-g | Send literal Ctrl-g to the focused application |

Show available commands after the prefix. Escape cancels. Invalid commands
cancel with visible feedback and are not forwarded to the shell. Clear pending
command state when the browser loses focus. During IME composition, leave input
with the composing control.

Use click-to-focus and a clear active-pane border. Directional movement selects
the nearest pane in that direction without wrapping. Returning to a GUI pane
restores its last focused control. GUI controls retain normal Tab navigation.
Browser and OS shortcuts remain available.

All menus, palette entries, and shortcuts invoke a central command registry.
Keep bindings separate from command implementations. Start with basic splits,
resizing, zoom, tabs, and directional focus; defer floating windows and elaborate
docking. Moving panes between tabs can follow the core prototype.

## Lifecycle and persistence

- Browser disconnect: detach the client and preserve running terminals.
- Pane close: remove the view and detach; do not terminate its process.
- Explicit terminal termination: end that terminal's tmux session and release
  its resources.
- Session reopen: restore layout and reattach available terminal resources.
- Container restart: running processes end. Preserve metadata and display
  unavailable terminals honestly; recreating a shell is an explicit action.
- Second client: require explicit takeover before granting terminal control.
  The previous controller must lose input and resize authority.

Store session and layout metadata as versioned JSON in a named volume. Use atomic
replacement for writes. Keep metadata separate from project files. It is useful
persistent state, not a trusted authorization source when stored in the
development environment.

tmux preserves processes and redraws the current terminal on reconnect. Complete
historical scrollback restoration is deferred. Offer a picker for detached
terminals so their processes remain discoverable.

Splitting creates a terminal in the configured workspace directory. Inheriting
the active shell's current directory is deferred. On focus or geometry changes,
the active controller supplies terminal dimensions to the bridge and PTY.

## Terminal protocol

Define a small versioned protocol in packages/protocol for attachment, input,
output, resize, exit, and errors. Validate client messages at runtime, including
terminal ownership and sensible dimension and payload limits. Shared TypeScript
types do not replace validation.

Keep xterm.js outside component state: create it on mount, forward events, and
dispose it on unmount. Browser detachment must not imply terminal termination.
Define bounded buffering and flow control so noisy commands and slow or
disconnected clients cannot cause unlimited memory growth. Avoid logging
terminal contents or credentials by default.

## Security and reproducibility

Treat repository code, dependencies, build scripts, and agent-generated commands
as potentially hostile. Development workloads should receive no credentials
except those deliberately provisioned for the coding agent. Those credentials
remain an acknowledged exposure within the development boundary.

For the prototype, inventory existing mounts, privileges, and exposed ports.
Minimize writable host mounts; keep project data in named volumes. Mount required
helper scripts read-only. Remove unnecessary privileged initialization and
seccomp exceptions after validating the supported workloads. Keep any necessary
exception narrow and documented.

Pin base images and tool versions and document persistent versus disposable
data. Reproducibility does not require preserving container processes across
rebuilds. The existing authenticated Git workflow remains transitional and must
not be described as enforcing the future GitHub policy.

## Later authenticated operations

Use a separate broker for authenticated operations. The selected policy is
approved repositories and agent-owned branches. A workspace gets an explicitly
assigned branch; a matching name prefix alone does not establish ownership.

Expose narrow operations such as publishing a snapshot to the assigned branch
and creating a PR against an allowed base. Initially disallow branch deletion,
force-push, merge, and repository administration. Resolve repository identity
from trusted configuration and validate every request independently of agent
instructions.

A GitHub App is the preferred credential source. Repository permissions and
short-lived tokens complement broker enforcement; they do not by themselves
establish the desired branch ownership policy. Do not execute untrusted Git
hooks, helpers, or repository configuration in the credential-bearing broker.
Private repository reads need an explicit authenticated path as well.

## Delivery plan

1. Tighten and document the Compose boundary, pin the runtime, and scaffold the
   workspace packages and checks.
2. Implement one terminal end to end with authenticated WebSocket transport,
   resize, bounded output handling, and tmux attachment.
3. Add two-pane composition, prefix commands, tab and layout persistence,
   reconnect, detached-terminal discovery, and controller takeover.
4. Implement and validate scoped GitHub publishing as a separate milestone.
5. Add a useful GUI pane, such as diff review or task status, and shared context.

## Prototype acceptance criteria

- Compose builds and starts the complete app from the repository using pinned
  dependencies and documented configuration.
- The app is reachable through a loopback-only host port. Unauthenticated
  connections and disallowed WebSocket origins are rejected.
- Two terminal panes run existing tools such as nvim and lazygit as the
  development user without Docker socket access.
- Prefix commands split panes, navigate, resize, switch tabs, and zoom. Literal
  prefix passthrough works, and normal terminal input and IME input remain usable.
- Resizing updates PTY dimensions. A high-output command does not create
  unbounded bridge buffering, and disconnect cleanup does not kill tmux work.
- Reloading or closing and reopening the frontend restores layout and running
  terminals, including the current terminal screen.
- Closing a pane preserves its terminal, which remains discoverable. Explicit
  termination ends it. Container restart shows unavailable terminals clearly.
- A second client cannot send input or resize a terminal until explicit takeover.
- Focus, clipboard, resizing, and reconnect behavior are checked in the selected
  desktop browser. Focus and lifecycle behavior have focused browser tests;
  protocol validation and PTY lifecycle have backend integration tests.
- Type checking, linting, formatting checks, and the production build pass.

## Deferred choices

PWA installation, arbitrary browser panes, preview integration, a database,
general plugins, advanced docking, full scrollback restoration, and a structured
agent backend are outside the initial prototype. Evaluate T3 Code behind an
adapter if concrete conversation and agent-event needs justify it.

Controlled previews should use a separate origin and restricted messaging.
Arbitrary sites may forbid embedding. Cross-origin frames do not automatically
forward keyboard commands to the parent; initially offer a visible focus-return
control outside the frame rather than promising global keyboard capture.
