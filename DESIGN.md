# Personal development workbench

Status: agreed direction for the first prototype.

## Intent

Build a personal, keyboard-first development workbench with tmux-like composition
and richer GUI panes. Keep existing terminal applications useful while migrating
individual workflows to GUI incrementally.

Development runs in Docker Compose on Docker Desktop on the user's computer.
Normal setup and broker provisioning require only Docker/Compose and standard
host shell utilities; do not require host Node, pnpm, Git, or build toolchains.
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
| API state | TanStack Query with @seiyab/ecq query factories |
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

Session and workspace reads use shared ECQ query factories. API writes use
TanStack Query mutations. The loaded workspace initializes a local layout draft;
terminal resources are read directly from the workspace query cache. Creating or
terminating a terminal updates that cache from the mutation response and
invalidates the workspace query. Opening the detached-terminal picker also
invalidates it. These refreshes do not replace the draft or its revision.
Layout saves stay queued and revision-checked. Automatic
focus/reconnect refetches and write retries are disabled, and authentication
expiry clears the cached workspace before the next sign-in.

## Work and layout model

A work session is a durable context for a task. It references a repository,
working directory, execution workspace, optional issue or PR, optional agent
conversations, terminal resources, and saved layout. It can exist before a PR or
agent conversation exists.

The current implementation starts with a name and an existing directory inside
one execution workspace. Each session owns a split layout and terminal resources;
no tabs, worktree creation, or external issue/PR integration yet. The selected
session survives browser reloads. Relative paths resolve from the workspace root.

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
- Shell exit: automatically close its pane; keep the work session, even if empty.
- Session switch: save pending edits, detach views, and preserve shells and layouts.
- Session archive: hide the context without terminating its shells; reopening
  unarchives it and restores its layout.
- Session delete: explicitly confirm termination of all of its terminals and remove
  its metadata, leaving project files intact.
- Session reopen: restore layout and reattach available terminal resources.
- Container restart: running processes end. Preserve metadata and display
  unavailable terminals honestly. Ended terminal panes close on attachment;
  starting a replacement shell requires an explicit new-terminal action.
- Second client: require explicit takeover before granting terminal control.
  The previous controller must lose input and resize authority.

Store session and layout metadata as versioned JSON in a named volume. Use atomic
replacement for writes. Keep metadata separate from project files. It is useful
persistent state, not a trusted authorization source when stored in the
development environment.

tmux preserves processes and redraws the current terminal on reconnect. Complete
historical scrollback restoration is deferred. Offer a picker for detached
terminals so their processes remain discoverable.

Splitting creates a terminal in the current work session’s configured directory. Inheriting
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

## GitHub authentication and operations

Status: agreed design. The [local publishing prototype](apps/git-broker/README.md)
and isolated Compose service with GitHub App authentication are implemented;
`box gh pr create` is implemented. Real GitHub pushes have been confirmed;
live PR creation remains to be validated after updating App permissions. GitHub authentication precedes
worktree-backed sessions. GitHub is the only initial provider, and private
clone/fetch is deferred. Public clone/fetch continues directly against GitHub.

### Trust boundary and identity

Run a credential broker as a separate Compose service outside the development
container. Only the broker receives the GitHub App private key and installation
credentials. Its policy and credential storage must not be mounted into the
development container or shared with its writable project/state volumes. Neither
service receives a Docker socket. Broker policy is managed outside the development
container; the terminal bridge and work-session metadata cannot grant permissions.

Provision explicitly through a profile-gated service in `compose.github.yaml`.
Read the App key from stdin and write policy/key and box capability to distinct
Docker-managed volumes. Mount only the capability volume into the workbench.
Do not require host output directories, input bind mounts, or host UID mapping.
Normal startup must not run provisioning or rotate capabilities.

The development container authenticates to the broker with a scoped capability.
This is authority that container code can exercise or copy, even though it is not
a GitHub credential. Assign a stable box identity and its repository grants from
trusted configuration; do not trust a caller-supplied box ID. Support revoking the
box capability independently of the GitHub App credentials. Agent and human
commands inside the same container share this authority. A work session is not a
separate security principal.

Use a GitHub App installed only on selected repositories. Installation tokens
stay in the broker, have bounded lifetimes, and use the permissions needed for
Git pushes and PR creation. App-authenticated PRs are attributed to the App/bot;
this is accepted. A user can create a PR in the GitHub browser UI when personal
attribution is preferred. Git commit authorship remains separate.

### Branch and operation policy

Each box receives a namespace such as `box/<box-id>/<topic>` on each approved
repository. It may create branches automatically within that namespace; approval
for every new branch is not required. The broker records branch ownership when
creating one. A matching prefix on an existing remote branch does not establish
ownership: adopting an existing branch requires a trusted administrative action.
The same namespace applies whether a human or an agent wrote the commits.

Initial authenticated operations are:

- Create a branch in the assigned namespace and push fast-forward updates to
  branches recorded as belonging to that box.
- Create a PR from an owned branch to an explicitly allowed base branch.
- Provide selected issue/PR reads through the broker API as CLI support is added.

Reject branch deletion, non-fast-forward updates, tag writes, merges, and
repository administration. Evaluate actual destination refs and commit ancestry
at the broker, independently of client flags, local branch names, or agent
instructions. A force flag must not authorize a history rewrite. Protect against
concurrent upstream updates so a stale check cannot lead to an overwrite.
Repository identity resolves through trusted grants; requests cannot select
arbitrary authenticated URLs. GitHub App repository permissions complement this
policy but do not express the branch-ownership restrictions themselves.

### Git and lazygit integration

Keep the normal public HTTPS fetch URL and configure a separate push URL using
Git's remote-helper mechanism. A container-side `git-remote-box` helper connects
to the broker. Normal commands such as `git push -u origin HEAD` should continue
to work, including when invoked by lazygit.

```text
Development container                 Broker                 GitHub
 git / lazygit -> git-remote-box  ->  validate + push  ->  approved repository
 box CLI / future MCP adapter    ->  operation API    ->  GitHub API
```

The helper transfers proposed commits and ref updates, not GitHub tokens. Treat
it as an untrusted client: the broker validates the received Git objects,
repository grant, destination ref, ownership, and permitted update itself. Local
Git configuration and helper changes cannot widen the broker's authority.

Use broker-controlled Git storage and configuration. Do not execute project Git
hooks, credential helpers, or repository configuration in the broker. Bound
incoming transfers and temporary storage. Return success only after GitHub accepts
the operation; copying data to the broker is not a successful push. Surface
upstream rejections and uncertain outcomes honestly. A general HTTP interception
proxy is outside the initial design.

Remote-helper compatibility, tracking/upstream updates, and lazygit behavior need
a prototype before committing to the final transfer implementation. Start with
one branch update per push and reject unsupported multi-ref operations explicitly
rather than silently applying only part of a request.

### GitHub command interfaces

Provide one narrow, operation-specific broker HTTP API and a small `box` CLI.
Start with `box gh pr create`; future reads can use `box gh pr view` and
`box gh issue view`. Provide human-readable
output and `--json` for scripts and agents. Both humans and coding agents use the
same commands and policy. CLI commands must not accept arbitrary authenticated
HTTP destinations or unrestricted API paths.

MCP can be added later as a thin adapter to the same operations and authorization.
Authenticated use of the actual `gh` command is deferred. Do not give it GitHub
tokens inside the container, and do not build a partial replacement pretending to
be `gh`. Supporting actual `gh` through a restricted API proxy would be a separate
compatibility project.

### Implementation sequence and acceptance

1. Prototype `git-remote-box` and broker-side validation against a local test
   upstream, without GitHub credentials (implemented as the local prototype). Demonstrate branch creation, subsequent
   fast-forward push, upstream tracking, and ordinary lazygit push. Confirm that
   forbidden refs, unowned existing branches, history rewrites, and unsupported
   operations fail clearly. Direct broker requests must face the same policy as
   helper requests. Exercise upstream rejection and concurrent updates.
2. Add the separate Compose broker service (implemented; see the
   [GitHub setup guide](apps/git-broker/GITHUB.md)), box provisioning/revocation, trusted
   repository/base-branch grants, and GitHub App token handling. Configure secrets
   outside the development image and verify that repository code cannot read them
   or change policy. Test real pushes on a designated repository. Permission
   denials must be visible in the terminal and lazygit; credentials must not appear
   in responses or logs.
3. Add the narrow GitHub API operations and `box` CLI, beginning with PR creation
   and issue/PR reads. Validate the head's repository and recorded box ownership,
   the allowed base, and App/bot attribution. PR creation is implemented: omitted
   repository base grants allow the default branch only; explicit `baseBranches`
   lists replace that policy. Git and PR operations use separate permission-scoped
   tokens. Issue/PR reads remain deferred. Record operation metadata for audit
   without storing credential values or terminal contents.
4. Add MCP, more authenticated operations, private reads, or work-session GUI
   integration only when needed. Worktree-backed sessions can build on the stable
   box/branch policy once the publishing path works.

## Delivery plan

1. Tighten and document the Compose boundary, pin the runtime, and scaffold the
   workspace packages and checks.
2. Implement one terminal end to end with authenticated WebSocket transport,
   resize, bounded output handling, and tmux attachment.
3. Add two-pane composition, prefix commands, tab and layout persistence,
   reconnect, detached-terminal discovery, and controller takeover.
4. Implement and validate broker-backed GitHub publishing and the `box` CLI
   following the sequence above, before worktree-backed sessions.
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
