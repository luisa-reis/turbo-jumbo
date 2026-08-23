# Setup and operations

Everything you need to develop, configure, and deploy Turbo Jumbo. For what the
tool is and why it exists, see the [README](../README.md). For the developer
workstation's toolchain — the `hf` downloader, ffmpeg, demo and narration
tooling — see [dev-setup.md](dev-setup.md).

## Development

```bash
cp config.yaml.sample config.yaml  # edit to match your setup
bun install
bun dev                             # http://localhost:3000
```

## Configuration

The app reads `config.yaml` from the working directory by default. Set `CONFIG_PATH` to use a different location:

```bash
CONFIG_PATH=/etc/turbo-jumbo/config.yaml bun start
```

All options are documented in [`config.yaml.sample`](../config.yaml.sample) and described formally in [`config.schema.json`](../config.schema.json) (JSON Schema). The config is validated against that schema on startup, so typos and missing required fields fail fast with a readable error. The sample YAML carries a `# yaml-language-server: $schema=./config.schema.json` modeline, which gives autocomplete and inline validation in editors with the [YAML extension](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml).

The config lists every `peer` (machine) that shares models, including this one. On startup the app identifies the **local** peer by matching a peer's address host against this machine's own IP addresses. A peer that holds models sets `base_path` (local models live in `<base_path>/turbo-jumbo`, Lemonade's cache in `<base_path>/lemonade`), and one with an archive sets `cold_storage_path`; both matter only on the machine they describe, so remote peers need only a `name` and `address`.

Neither path is required. A machine whose peer entry has no `base_path` — or that isn't in the peer list at all — runs as a **viewer**: it shows every peer's models on the All tab, and downloads, copies and deletes run on the peers themselves (copies go peer to peer without passing through the viewer). It has no tab of its own, is offered nowhere as a destination, and the All tab's _Add model_ is absent — start downloads from a peer's tab instead. A viewer needs no entry in the other machines' configs; there is nothing for them to fetch from it. Cold storage is independent of this: a machine with only `cold_storage_path` gets the Cold Storage tab and nothing else of its own.

## Deploying with bun and systemd

The app runs straight on [bun](https://bun.sh) from Next's standalone
bundle, under a systemd _user_ unit on the target machine, which needs only
bun, the `hf` CLI (for downloads), rsync and ssh access for the deploying
account. No container runtime is involved.

On the target, as the account the app will run as:

- Put the config at `~/tj/config.yaml` and, for gated or private Hugging Face
  repos, the token in `~/hf_token.txt` (mode 600). The unit reads both from
  those paths; `~/tj/tj.env` can override any of its environment (`PORT`,
  `CONFIG_PATH`, …), one `KEY=value` per line.
- Have root run `loginctl enable-linger <account>` once. A user unit only
  starts at boot, and only outlives the account's login sessions, for a
  lingering account.

On the machine you build from, copy [`deploy/env.sample`](../deploy/env.sample)
into `.env` at the repo root and set `DEPLOY_HOST=<account>@<host>`. Then:

```bash
bin/deploy.sh        # build, ship, install the unit, restart, health-check
bin/deploy.sh -n     # build and report what would ship, touching nothing
```

Each deploy lands in `~/tj/releases/<stamp>/` and flips the `~/tj/current`
symlink the unit runs from; the last three releases are kept, so rolling
back is pointing `current` at an older one and
`systemctl --user restart turbo-jumbo`. Logs are in
`journalctl --user -u turbo-jumbo`.

A machine without a model store of its own — the viewer described under
"Configuration" above — deploys the same way; only its `config.yaml` differs.

## Building a container image

Requires [Podman](https://podman.io).

```bash
bun docker:build
```

This produces `turbo-jumbo.tar.gz` in the repo root — a self-contained image with no registry involved.

## Deploying the container on another machine

Copy `turbo-jumbo.tar.gz` to the target machine, then:

```bash
podman load < turbo-jumbo.tar.gz

podman run -p 3000:3000 \
  -v /path/to/config.yaml:/config/config.yaml:ro \
  -v /mnt/models:/mnt/models:rw \
  -v /mnt/cold-storage:/mnt/cold-storage:rw \
  turbo-jumbo
```

The two model directory mounts should match the local peer's `base_path` and `cold_storage_path` values in your `config.yaml`. Using the same path inside and outside the container means the config file works unchanged. A viewer needs neither mount.

The container expects the config at `/config/config.yaml` by default. Override with `-e CONFIG_PATH=...` if you mount it elsewhere:

```bash
podman run -p 3000:3000 \
  -e CONFIG_PATH=/data/myconfig.yaml \
  -v /path/to/config.yaml:/data/myconfig.yaml:ro \
  -v /mnt/models:/mnt/models:rw \
  -v /mnt/cold-storage:/mnt/cold-storage:rw \
  turbo-jumbo
```

## Syncing Lemonade models

The **Sync from Lemonade** button consolidates Lemonade's HuggingFace-cache
models into Turbo Jumbo's flat layout so a single copy on disk serves both. A
file that exists only in Lemonade is moved into `<base_path>/turbo-jumbo`; a file
Turbo Jumbo already holds an identical copy of has its redundant Lemonade copy
deleted instead. Either way the Lemonade copy is then replaced with a symbolic
link back to the Turbo Jumbo file.

It also works the other way: a model in Lemonade's catalog that Turbo Jumbo
already has but Lemonade hasn't downloaded is recreated in Lemonade's cache as
symbolic links into Turbo Jumbo, so Lemonade can use it without re-downloading.

Both halves write _inside_ the Lemonade cache directory — moving the original
file out, then creating the symlink in its place. Lemonade runs as its own
service user, so that directory is usually owned by a different user than the
one running Turbo Jumbo, and the sync fails with `EACCES` ("permission denied").

Grant the Turbo Jumbo user write access to the cache with a POSIX ACL — an
extended attribute (`system.posix_acl_access`) the kernel honours alongside the
normal owner/group bits, so no `chown` and no running Turbo Jumbo as root. Run
these once, as a sudoer, replacing `<tj-user>` with the account Turbo Jumbo runs
as and the path with your `<base_path>/lemonade`:

```bash
# rwx on every existing file and directory in the cache…
sudo setfacl -R -m u:<tj-user>:rwx /mnt/models/lemonade

# …and a *default* ACL so snapshots Lemonade downloads later inherit it.
sudo setfacl -R -d -m u:<tj-user>:rwx /mnt/models/lemonade
```

Verify with `getfacl /mnt/models/lemonade` (look for `user:<tj-user>:rwx` and a
`default:user:<tj-user>:rwx` entry). The filesystem must be mounted with ACL
support — the default on ext4/xfs/btrfs; for others add the `acl` mount option.

Turbo Jumbo's own local model directory needs no change: it's already owned by
the Turbo Jumbo user, and the sync only writes real files there.

## Example models

Handy small models for trying the app out:

- [unsloth/gemma-3-4b-it-GGUF](https://huggingface.co/unsloth/gemma-3-4b-it-GGUF/tree/main)
- [unsloth/granite-4.0-h-tiny-GGUF](https://huggingface.co/unsloth/granite-4.0-h-tiny-GGUF/tree/main)
- [unsloth/Jan-nano-128k-GGUF](https://huggingface.co/unsloth/Jan-nano-128k-GGUF/tree/main)
- [unsloth/LFM2-1.2B-GGUF](https://huggingface.co/unsloth/LFM2-1.2B-GGUF/tree/main)
- [unsloth/Llama-3.2-3B-Instruct-GGUF](https://huggingface.co/unsloth/Llama-3.2-3B-Instruct-GGUF/tree/main)
- [unsloth/Ministral-3-3B-Instruct-2512-GGUF](https://huggingface.co/unsloth/Ministral-3-3B-Instruct-2512-GGUF/tree/main)
- [unsloth/Phi-4-mini-instruct-GGUF](https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/tree/main)
- [unsloth/Qwen3-4B-Instruct-2507-GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/tree/main)
- [unsloth/SmolLM3-3B-GGUF](https://huggingface.co/unsloth/SmolLM3-3B-GGUF/tree/main)

Source: [Lemonade's llm debate demo](https://github.com/lemonade-sdk/lemonade/blob/main/examples/llm-debate.html)
