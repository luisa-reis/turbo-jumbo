# Bare-metal deployment: a viewer host plus storage peers

## Why

Production used to be one container on a VM that mounted the GPU host's
model store: that VM was both the UI and that GPU host's storage peer. The new
production host is an unprivileged LXC container with the cold-storage NFS
share and _no_ local model store — it cannot see any GPU host's disk, so it
cannot be a storage peer for anyone. The container pipeline is dead at both
ends anyway: the last container exited months ago, its tarball and config
predate the current config schema, and the new host has no podman.

Two things follow:

1. **Production is a fleet, not a box.** The new host is the front door — it
   shows every peer's models and drives their downloads, copies and deletes —
   and the model stores stay with the machines that hold the disks, each
   running the same app as a peer. This is the "one UI host, thin agents"
   shape of [the storage-interface design](2026-08-10-storage-interface-design.md),
   with the full app standing in for an agent until one exists; a peer is
   the same thing to every caller either way.
2. **The app runs straight on bun**, from Next's standalone bundle, under a
   systemd user unit. No image, no registry, no container runtime.

## The front door

The production host's own peer entry has `cold_storage_path` and no
`base_path`: it is a viewer with an archive (see "Configuration" in
`docs/setup.md`). It gets the All tab and the Cold Storage tab, is never
offered as a copy destination, and has no _Add model_ on All — downloads
start from a peer's tab and run on that peer. Copies between peers are
peer-to-peer pushes; bytes never cross the front door. Lemonade browsing and
FLM pulls talk to each GPU host's Lemonade server directly, so its
`lemonade_url`/`lemonade_api_key` live in the front door's config too.

Cold storage is one NFS share mounted at the same path on every machine, so
every peer entry carries the same `cold_storage_path`; the front door's
Cold Storage tab and the peers' cold copies are the same files.

## The storage peers

Each machine with a model store runs the app against its own `base_path`,
as today. Nothing about them changes in this design. One of them is still
served by a development server started from a login shell; giving it the
same unit and deploy path below is a follow-up, not part of this change.

## Deploying

`bin/deploy.sh` is the one command. It:

1. Builds locally with `NEXT_DIST_DIR=.next-deploy`, so the developer's own
   `.next` (and the dev server reading it) is untouched, and restores the
   `tsconfig.json` that Next rewrites on every build.
2. Stages the release from Next's standalone output by allow-list —
   `server.js`, `package.json`, the traced `node_modules`, the dist dir,
   the static assets, `public/` — rather than shipping that output
   wholesale: file tracing pulls the repo root into it, the developer's
   `config.yaml` and `hf_token.txt` included. It then stamps the stage with a
   `release.env` carrying `TJ_COMMIT` and, for a clean build of a tagged
   revision, `TJ_RELEASE` (the rule `bin/docker-build.sh` and
   `lib/version/app-version.ts` already share).
3. Ships it with rsync to `~/<dir>/releases/<stamp>/` on the target, flips
   the `~/<dir>/current` symlink, installs or refreshes the user unit,
   restarts it, and waits for `/api/v1/version` to report the shipped
   commit. The last few releases are kept, so a rollback is a symlink flip
   and a restart.

The target comes from the uncommitted `.env` (`DEPLOY_HOST`, optionally
`DEPLOY_DIR`, `DEPLOY_PORT`, `DEPLOY_KEEP`) — hostnames never enter the
repository — with the samples in `deploy/env.sample`. The script is
host-agnostic: pointing `DEPLOY_HOST` at a storage peer deploys the same
build there.

The build happens on the developer machine because the production host is
small. The bundle is JavaScript plus one prebuilt native dependency (`sharp`,
which Next traces in for image optimization, shipped for Linux x64 on both
glibc and musl), so a same-architecture Linux build runs on the host
unchanged — the container image was built the same way, on a different
distribution, and ran.

## Running

`deploy/turbo-jumbo.service` is a systemd _user_ unit for the account the
app runs as: `WorkingDirectory=%h/<dir>/current`, `bun server.js`,
`Restart=always`, `WantedBy=default.target`. It sets `NODE_ENV`,
`HOSTNAME=0.0.0.0`, `PORT` and `CONFIG_PATH` to `~/<dir>/config.yaml`, and
nothing for `hf`. An optional `~/<dir>/tj.env` can override any of these
per host, and is where a storage peer puts everything the `hf` CLI needs —
its `PATH` entry, `HF_XET_HIGH_PERFORMANCE`, the token for gated repos
(`deploy/tj.env.sample` lists them); `release.env` from the current release
is read after it. The front door runs no downloads — `hf` is only ever
spawned on the peer the download lands on — so none of that is configured
there.

A user unit survives reboots only when the account lingers
(`loginctl enable-linger <user>`, once, as root); without that the user
manager — and the service under it — stops with the account's last login
session.

## What moves from the old host

The account's home: the old config, kept beside the new one for reference.
Not moved: the Hugging Face token (the front door never spawns `hf`, and
nothing else reads it), the container image storage (the runtime it fed is
gone), the two hf virtualenvs
(their shebangs hardcode the old home path, and the new host has a newer
`hf` installed), and the shell/ssh dotfiles the new host's provisioning
owns — overwriting `authorized_keys` in particular could lock the deployer
out.

## Out of scope

DNS or proxy changes, root steps on the host (flagged to the operator
instead), edits to the infrastructure repository that owns the base box,
and deploying the storage peers.
