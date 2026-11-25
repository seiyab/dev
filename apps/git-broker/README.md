# Local Git publishing prototype

This is the first stage of the broker design in [DESIGN.md](../../DESIGN.md#github-authentication-and-operations).
It exercises real Git pushes against a **local test bare repository**, with no
GitHub credentials or GitHub writes. For the separate Compose service with
GitHub App authentication, see
[GitHub publishing setup](GITHUB.md), including `box gh pr create`.
PR creation requires a GitHub upstream; the local prototype only exercises Git pushes.

## Try it

From the repository root, with the pinned Node/pnpm versions and Git installed:

```sh
pnpm install --frozen-lockfile
pnpm broker:demo
```

The demo creates a seed repository, bare upstream, checkout, scoped capability,
and broker state under a new temporary directory. It prints commands to run in a
second terminal; copy those commands to configure `PATH`, `BOX_BROKER_URL`, and
`BOX_CAPABILITY_FILE`, and enter the checkout. The capability's value is not printed.

The checkout has an ordinary fetch URL and a push URL of `box::demo/repository`.
It starts on `box/demo/topic`. Commit a change, then run:

```sh
git push -u origin HEAD
# After another commit:
git push
# Or launch lazygit and use its normal P push key.
```

Pushes to `main`, tags, another box's namespace, or unowned existing branches
are rejected. Deletion, history rewrites (even with `--force`), and multi-ref
pushes are also rejected. `git push --dry-run` validates the proposed update but
does not publish or reserve ownership. Ordinary fetch continues through the
original fetch URL; the helper is push-only.

Stop the broker with Ctrl-C. Demo files remain available for inspection at the
printed directory. Nothing is configured in your real repositories or global Git
configuration. Treat the demo checkout and upstream as test data, not as a deployed
security boundary: both are accessible to your local user.

## Trusted configuration

The demo writes `broker.json` beside its checkout. To run a prepared configuration:

```sh
pnpm --filter @workbench/git-broker build
node apps/git-broker/dist/index.js /absolute/path/to/broker.json
```

Local-demo configuration contains a `port` (zero selects a free port), absolute
`stateDir`,
`repositories: [{ id, upstream }]`, and `boxes: [{ id, capabilityFile, repositories }]`.
Repository IDs have the form `owner/repository`; upstreams must be absolute paths
to trusted, local SHA-1 bare repositories. Aliases cannot share an upstream.
Capability files contain 32 random bytes encoded as 64 hexadecimal characters.
The demo creates them with mode 0600. The grant derives box identity from the
capability; supplying a different `boxId` in a request does not change authority.
Changing grants or revoking a capability currently requires a broker restart.

The local demo binds only `127.0.0.1`. The helper accepts HTTP on loopback or the
Compose service name `git-broker`. It reads its capability from
`BOX_CAPABILITY_FILE` and sends it in an Authorization header, never a remote URL. Browser-origin requests are rejected. There is no
GitHub credential helper, arbitrary authenticated URL, or generic proxy endpoint.

Run one broker process per state directory. Keep its configuration, state, and
upstream separate from developer-controlled checkouts. The local demo does not
make a process inaccessible to other processes under the same user. Use the separate Compose deployment for the development/broker
container boundary; do not use the local demo to hold GitHub credentials.

## How pushes work

Git invokes `git-remote-box` through its [remote-helper protocol](https://git-scm.com/docs/gitremote-helpers).
The helper lists upstream refs and sends one destination ref, expected old commit,
proposed commit, and a self-contained Git bundle. Full bundles make the prototype
simple but are limited to 8 MiB; large and shallow repositories are not supported.
The helper removes its temporary `refs/box-upload/*` ref after preparing a bundle.
No custom lazygit commands or Git aliases are required.

The broker independently checks the repository grant, the actual destination
`refs/heads/box/<box-id>/<topic>`, and recorded ownership. It imports and checks
objects in a fresh bare repository with broker-controlled Git configuration and
hooks disabled. Non-commit tips and non-fast-forward updates are rejected. Client
flags and configuration cannot authorize a rewrite.

Pushes are serialized per repository. Git's upstream lease check protects the
write against a change after validation. Success is returned only after the
upstream push succeeds. Rejection, timeout, or a lost response is an error; fetch
and inspect upstream before retrying an uncertain outcome.

`ownership.json` is atomically replaced. New branches get a pending reservation
before publication and an owned record afterward. If a process dies between
publication and recording ownership, a later request can reconcile only when the
upstream exactly matches the reserved tip. An existing branch without matching
ownership is never automatically adopted. Other uncertain cases require trusted
reconciliation rather than deleting metadata and guessing ownership.

`audit.jsonl` records push results, repository/ref names, and commit IDs without
capabilities or bundle contents. Invalid requests rejected before push processing
are not currently included. Temporary incoming repositories are cleaned up after
requests. Hard disk quotas, hostile-pack resource isolation, incremental transfer,
multiple broker instances, and production recovery tooling remain future work.

## Verification

`pnpm test` builds the helper and runs Git/HTTP integration tests. These cover
upstream tracking, restart persistence and pending ownership, policy bypass
attempts through the direct API, competing writes, invalid objects, transfer size,
dry-run, upstream rejection, and cleanup of temporary helper refs.

The lazygit test drives its default push key in a real PTY. It uses `lazygit` from
`PATH`, or an explicit binary:

```sh
BOX_TEST_LAZYGIT=/path/to/lazygit pnpm test
```

That test is skipped when lazygit is unavailable. The workbench-pinned lazygit
release is the intended compatibility target.
GitHub unit tests exercise JWT signing, token scope/refresh, repository identity,
credential handling, and secret provisioning without using a live App key.
