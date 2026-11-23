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

## Provision into Docker-managed volumes

Only Docker with Compose and a standard host shell are required. No host Node,
pnpm, Git, build tools, UID/GID settings, or writable host bind mounts are needed.
From the repo root, supply the non-secret settings through environment variables:

```sh
export WORKBENCH_BOX_ID=local
export WORKBENCH_GITHUB_APP_ID=REPLACE_WITH_APP_OR_CLIENT_ID
export WORKBENCH_GITHUB_REPOSITORIES='[{"id":"OWNER/REPO","repositoryId":123456,"installationId":789012}]'
```

Then pipe the downloaded App private key into the one-off provisioner:

```sh
docker compose -f compose.workbench.yaml -f compose.github.yaml run --build --rm -T broker-provision < "/absolute/path/to/the-app-private-key.pem"
```

The shell reads that existing host file; the container receives its contents on
stdin. The key is not passed in arguments, environment variables, or a host bind
mount, and is never printed. The provisioner accepts only an unencrypted RSA key,
with a 64 KiB input limit. Its runtime has no network, Docker socket, or Linux
capabilities, and its root filesystem is read-only. Building the image still needs
network access to download dependencies.

Provisioning writes only to two named volumes, as the image's fixed non-root
`node` user:

| Volume                      | Contents            | Provisioner | Broker    | Workbench |
| --------------------------- | ------------------- | ----------- | --------- | --------- |
| `github-broker-credentials` | App key and policy  | Read/write  | Read-only | No mount  |
| `github-box-capability`     | Box capability only | Read/write  | Read-only | Read-only |

Volume directories are 0700 and files are 0400. The workbench never receives the
App key or policy. The broker's writable state stays in the separate
`github-broker-state` volume. Named volumes consume Docker-managed storage on the
host, but containers do not write into ordinary host directories.

The provisioner lives in `compose.github.yaml` under the `provision` profile.
Explicit `run broker-provision` enables that service; normal `up` does not run it.
Provisioning preserves an existing capability unless `--rotate` is given, and
refuses to change the existing box identity. Each Compose project should have its
own box identity and volumes. A box's namespace is `box/<boxId>/<topic>`; all
sessions and processes in that workbench share its authority.

## Start the services

After successful provisioning:

```sh
docker compose -f compose.workbench.yaml -f compose.github.yaml up --build -d
```

Starting without provisioning fails because the broker has no policy or key.
The broker's root filesystem is read-only, it has no Linux capabilities, and it
publishes no host port. No project or workbench-state volume is shared with it.

The services communicate over a private internal network. The broker has a
separate network for GitHub egress; the workbench retains its ordinary development
network. Neither service has the Docker socket. These are container isolation
boundaries; the broker itself, its Git implementation, and the Docker Desktop
host remain trusted.

If migrating from the earlier host-directory setup, provision the named volumes
with the same box ID and repository grants, then recreate the services with
`up --build --force-recreate -d`. The existing broker-state volume preserves branch
ownership. Old host output files are no longer read or mounted; remove obsolete
copies yourself after verifying the new setup if desired. Recreating the workbench
stops its shells but preserves project files and saved layouts.

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

Set the provisioning environment variables again when using a new shell. Change
`WORKBENCH_GITHUB_REPOSITORIES` to update grants; `[]` revokes all publishing grants.
Stop the broker while updating its policy and credentials, provision again through
stdin, then start it again:

```sh
docker compose -f compose.workbench.yaml -f compose.github.yaml stop git-broker
docker compose -f compose.workbench.yaml -f compose.github.yaml run --build --rm -T broker-provision < "/absolute/path/to/the-app-private-key.pem"
docker compose -f compose.workbench.yaml -f compose.github.yaml up -d git-broker
```

To invalidate a copied capability, use `broker-provision --rotate` in that same
sequence. It still reads the key from stdin. Existing workbench terminals can keep
running: directory volume mounts expose updated files, the helper rereads its
capability on each invocation, and starting the broker reloads its key and policy.
The continuing workbench intentionally receives the replacement capability;
rotation does not revoke its access. To revoke access immediately, stop the broker
or remove its grants and reload it. App key revocation is managed through GitHub.

Keep all three named volumes. Removing broker state does not safely adopt existing
branches: they will be rejected until trusted reconciliation is performed. Removing
the credentials or capability volumes requires provisioning again. Avoid
`docker compose down --volumes` unless you intend to remove those credentials,
ownership metadata, and the workbench's project/state data.

There is one broker process per state directory. Full bundles remain limited to
8 MiB; private repositories, large/shallow repositories, multi-ref pushes, and
production recovery tooling are deferred.
