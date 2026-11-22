# GitHub publishing from the workbench

The optional `compose.github.yaml` overlay adds a separate Git publishing broker.
The normal `compose.workbench.yaml` remains usable without GitHub configuration.
PR creation and the `box` CLI are a later stage; this stage enables Git/lazygit pushes.

## Prepare the App and repository grant

Use a GitHub App installed on **only selected repositories**. For this stage grant
repository **Contents: Read and write**; Metadata read access is implicit. The
broker requests installation tokens scoped to one numeric repository ID at a time
and only Contents write permission. It does not request Workflows permission, so
publishing workflow changes may be rejected by GitHub. No OAuth user login or
webhook receiver is needed for these operations.

Keep the downloaded RSA private key on your Docker Desktop host, outside this
repository. Gather the App/client ID, installation ID, canonical `OWNER/REPO`, and
numeric repository ID. Public repository metadata is available from
`https://api.github.com/repos/OWNER/REPO`. Installation IDs are available from the
App's installation settings or the GitHub App API. See GitHub's
[installation authentication documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

Only public repositories are supported in this stage. The broker verifies numeric
identity, canonical name, and public visibility before using an installation token
for Git. Public clone/fetch continues directly to GitHub; neither `gh auth login`
nor a GitHub token inside the workbench is required.

## Provision outside the repository

On your Docker Desktop host, create an input JSON file, for example
`~/.config/dev-workbench-broker-input.json`. Only Docker with Compose and standard
host shell utilities are required; Node, pnpm, Git, and build tools run inside
containers:

```json
{
  "boxId": "local",
  "appId": "REPLACE_WITH_APP_OR_CLIENT_ID",
  "repositories": [
    {
      "id": "OWNER/REPO",
      "repositoryId": 123456,
      "installationId": 789012
    }
  ]
}
```

From the repo root, set the paths and your host user/group IDs (macOS or Linux):

```sh
export WORKBENCH_BROKER_INPUT="$HOME/.config/dev-workbench-broker-input.json"
export WORKBENCH_GITHUB_APP_KEY="/absolute/path/to/the-app-private-key.pem"
export WORKBENCH_BROKER_DIR="$HOME/.config/dev-workbench-broker"
export WORKBENCH_UID="$(id -u)"
export WORKBENCH_GID="$(id -g)"
mkdir -p "$WORKBENCH_BROKER_DIR"
chmod 700 "$WORKBENCH_BROKER_DIR"
docker compose -f compose.provision.yaml run --build --rm broker-provision
```

The one-off provisioner runs as your host UID/GID, has no network access or Linux
capabilities, and has a read-only root filesystem. Its only host mounts are the
input JSON and App key (read-only) and the output directory (writable). It does not
mount your home directory or source checkout, and does not receive the Docker
socket. The key path is selected by the mount, so the JSON does not need a host
`privateKeyFile` field.

This validates and copies the key, generates a random scoped box capability, and
writes a broker policy. The output directory must be private (0700), owned by you,
and outside the source repository. Files are read-only (0444) so non-root container
users can read file-backed Compose secrets; the private parent directory protects
host access. The private key and capability values are never printed. Keep the
whole directory outside version control and Docker build contexts.

Provisioning an existing directory preserves its box capability and refuses to
change box identity. Use a different directory for a different box. A box's
namespace is `box/<boxId>/<topic>`; all sessions and processes in that workbench
share its authority.

## Start the services

```sh
export WORKBENCH_BROKER_DIR="$HOME/.config/dev-workbench-broker"
docker compose -f compose.workbench.yaml -f compose.github.yaml config --quiet
docker compose -f compose.workbench.yaml -f compose.github.yaml up --build --force-recreate -d
```

Recreating the workbench stops its running shells; project data and saved layouts
remain in their volumes. The broker has its own state volume, a read-only root
filesystem, no Linux capabilities, and no published host port. Only the box
capability is mounted into the workbench. The App key and policy are mounted only
into the broker, and no project or workbench-state volume is shared with it.

The services communicate over a private internal network. The broker has a
separate network for GitHub egress; the workbench retains its ordinary development
network. Neither service has the Docker socket. These are container isolation
boundaries; the broker itself, its Git implementation, and the Docker Desktop
host remain trusted.

## Verify access and push

Inside a workbench terminal, use an existing clone of the approved repository or
clone its public HTTPS URL. Configure only the push URL:

```sh
git remote set-url --push origin box::OWNER/REPO
git ls-remote box::OWNER/REPO
```

The ref listing checks broker authentication, App access, and repository identity
without changing GitHub. Fetch stays on the original GitHub HTTPS URL.

For a test push in a designated repository, with `boxId` set to `local`:

```sh
git switch -c box/local/auth-smoke
git commit --allow-empty -m 'Verify broker publishing'
git push --dry-run -u origin HEAD
git push -u origin HEAD
```

The last command creates the remote branch and upstream tracking. It can trigger
that repository's normal push workflows. Keep this branch or remove it manually
through GitHub; the broker intentionally cannot delete branches. Subsequent
commits use ordinary `git push` or lazygit's normal **P** binding. Git commit
identity remains your configured author/committer identity; App-authenticated API
operations such as future PR creation use the App/bot identity.

With that new commit still ahead of the base branch, `git push origin HEAD:main`
should fail with a broker namespace rejection. Other boxes' namespaces, tags,
branch deletions, non-fast-forward updates, and unowned existing branches are also
rejected. An existing matching prefix does not make a branch owned by the box.

GitHub branch rules or insufficient App permissions can reject a push even after
the broker validates it. Failures are reported through Git/lazygit without raw
GitHub error bodies or credential values. Redirects are disabled, so a repository
rename or transfer requires updating the trusted grant. A failed or interrupted
push can have an uncertain upstream outcome: fetch and inspect before retrying.

## Update grants, revoke, and rotate

Keep the provisioning environment variables set (or export them again in a new
shell). Edit the input and rerun the same Docker provisioning command to change
repository grants;
an empty repositories list revokes all publishing grants. Recreate **both** services
with the overlay after changing policy, key, or capability files. Compose file
mounts can retain the old inode after atomic replacement, so a process restart
alone is insufficient.

To invalidate a copied capability while keeping the same box identity:

```sh
docker compose -f compose.provision.yaml run --build --rm broker-provision --rotate
docker compose -f compose.workbench.yaml -f compose.github.yaml up --force-recreate -d
```

The continuing workbench intentionally receives the new capability. To revoke
access immediately, stop the broker service or remove its grants and recreate it;
rotating a capability does not remove authority from a workbench that receives
the replacement. App key rotation/revocation is managed through GitHub and the
private provisioning input.

Keep the broker state volume: it records branch ownership and pending creations.
Removing it does not safely adopt existing branches; those branches will be
rejected until trusted reconciliation is performed. There is one broker process
per state directory. Full bundles remain limited to 8 MiB; private repositories,
large/shallow repositories, multi-ref pushes, and production recovery tooling are
deferred.
