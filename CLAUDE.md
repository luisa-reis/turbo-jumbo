# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Turbo Jumbo: a tool to download AI models (from HuggingFace) and transfer them between machines. Every machine ("peer") runs the same Next.js app; one config lists all peers including this one. Models live in three places — **local** fast storage, **cold storage** (slow archival), and on **other peers** — and the app's job is to keep the right models present in each. Models can have multiple quantizations, each a single file or a split (sharded) set.

## Commands

```bash
bun dev        # Start dev server at http://localhost:3000
bun build      # Production build
bun start      # Run production build
bun test       # Run all tests (bun's test runner; .test.ts files are co-located in lib/)
bun test lib/audit/audit.test.ts    # Run a single test file
bun test --test-name-pattern <re>   # Run tests whose name matches a regex
bun lint          # ESLint
bun format        # Prettier write
bun format:check  # Prettier check
bun typecheck       # tsc --noEmit (TypeScript 7)
bun typecheck:watch # tsc --noEmit --watch (TypeScript 7)
jj commit -m "<message>"  # Commit (this repo uses Jujutsu, not git)
```

**Package manager is Bun** (not npm/yarn). Run JS/TS with `bun` (`bun -e "…"`, `bun run …`), never `node`; use `bunx`, not `npx`. **Version control is Jujutsu** (`jj`, not `git`).

**Two TypeScripts are installed on purpose.** TypeScript 7 ships no JS compiler API, which typescript-eslint, Next and editors all need, so the `typescript` package stays at 6.x to serve that API while TS 7 is installed as `@typescript/native` and does the actual typechecking. Both packages provide a `tsc` binary, so `node_modules/.bin/tsc` is ambiguous — the typecheck scripts call `node_modules/@typescript/native/bin/tsc` by path, and anything else wanting a specific compiler should too. Collapse this back to a single `typescript` once typescript-eslint supports TS 7 (upstream issue 10940).

## Releases and the changelog

- `CHANGELOG.md` is hand-curated ([Keep a Changelog](https://keepachangelog.com)). **When a change is user-visible, add a bullet under `## [Unreleased]` in the same commit**, written for users of the app ("searching the catalog now finds…"), not restyled commit subjects. Internal-only changes (refactors, dev tooling) stay out.
- `bin/release.sh <version>` cuts a release: stamps the Unreleased section, bumps `package.json`, commits, moves `main`, creates the annotated `v<version>` tag, builds the standalone `tj` CLI binaries (`bin/build-cli.sh`, into `build/cli/`), pushes branch + tag to `origin` (Forgejo, source of truth) and `github` (public mirror), and publishes the changelog section as release notes on both forges (`GITHUB_TOKEN`/`FORGEJO_TOKEN` from `.env`), attaching the CLI binaries to the Forgejo release.
- The app reports its version identity (`lib/version/`) in the header and at `/api/v1/version`: `dev: true` unless the running code is exactly a clean checkout of the `v<package.json version>` tag. Docker builds are stamped by `bin/docker-build.sh` (`TJ_RELEASE`/`TJ_COMMIT` env), since images carry no git checkout; the compiled CLI gets the same stamp as compile-time literals (`bin/build-cli.sh`). A stamp, when present, wins over git.

## Architecture

Next.js 16 **App Router** + React 19, served by plain `next dev`/`next start` (no custom server). Live peer notifications ride on two Next-native pieces:

- **Peer monitor** (`lib/peers/peer-monitor.ts`), started once at server boot from `instrumentation.ts`. Polls each remote peer's `/api/v1/local-models` every `peer_check_interval` seconds and publishes `peer-up`/`peer-down` events (`lib/peers/peer-event-types.ts`) into an in-process hub (`lib/peers/peer-event-hub.ts`; state lives on `globalThis` because instrumentation and route handlers are separate module graphs).
- **SSE stream** at `/api/v1/events` (a streaming Route Handler): replays the hub's current peer state on connect, then forwards events. Browsers subscribe through `lib/peers/peer-event-client.ts`, which multiplexes all client-side subscribers over one auto-reconnecting `EventSource`. WebSockets are deliberately avoided: Next's router owns HTTP `upgrade` handling and kills upgrades on paths that match a route (the `[[...location]]` catch-all matches everything).

**Directory layout:** `app/` holds only routing (layouts, pages, and `app/api/v1/` route handlers). Non-routing React components live in `components/`; non-React shared logic and its tests in `lib/`. Group modules into subdirectories by feature or theme rather than letting files accumulate at the top level — this applies to `components/` (e.g. `components/lemonade/`, `components/cells/`) and equally to `lib/` (e.g. `lib/audit/`, `lib/hf/`). Path alias `@/*` resolves to the repo root. TypeScript strict mode.

### Configuration (`lib/config/index.ts`, `config.schema.json`)

Loaded from `./config.yaml` (override with `CONFIG_PATH`), validated against `config.schema.json` with Ajv. The **local peer is identified by matching a peer's address host against this machine's own IP addresses**. Its `base_path` (local models at `<base_path>/turbo-jumbo`, Lemonade's cache at `<base_path>/lemonade`) and `cold_storage_path` are each optional: a local peer without `base_path` — or a machine that matches no peer at all — is a **viewer**, which runs the UI and drives the other peers but holds no models. `lib/config` exports `modelPeers` (the peers to present as locations, minus a viewer) and `localModelsPeer` (this machine as a location, or undefined) for everything client-facing; the `peers/[slug]` proxies and the peer monitor keep using `config.peers`. Remote peers need only `name` + `address`. See `config.yaml.sample`.

### Peers and the API

Each peer serves `app/api/v1/*`. Routes under `app/api/v1/peers/[name]/*` are **proxies**: the local app forwards to the named remote peer's matching endpoint (e.g. a peer's models, disk usage, hf-download). This lets the UI drive downloads and audits on remote machines through the local instance.

`app/api/v1/cli/*` serves the standalone `tj` binaries from `build/cli/` under the server's working directory (`TJ_CLI_DIR` overrides; allow-list in `lib/cli/binaries.ts`), and the `/cli` page (`app/(chrome)/cli`, linked from the top bar) gives install steps for them. `bin/deploy.sh` and the `Containerfile` build them into every deploy; in dev, run `bin/build-cli.sh` first or the routes 404.

### Model identity and provenance (sidecars)

Models are discovered by **synchronously scanning the filesystem** (`lib/models/models.ts`), not a database. Provenance is recorded in sidecar files alongside the weights:

- **`<file>.tjmeta.json`** (`lib/models/tjmeta.ts`) — per-file record: the HF `modelUrl`/`originUrl` it came from, expected vs. computed size and SHA256, and the resolved source commit.
- **`tjmodel.json`** (`lib/models/model-sidecar.ts`) — per-model sidecar in the model directory: shared identity (`repoId`, `repoCommit`) plus one entry per file. A model's revision is derived from its files' commits (`MIXED_COMMIT` when they disagree).

A model's **name** comes from its sidecar's `org/repo` when present, otherwise the filename — so the _same_ file can be named differently on two peers. Cross-peer matching therefore joins on **file basename**, not model name (`lib/peers/peer-paths.ts`): specific basenames (GGUF, dtype-tagged) join on their own; generic weight names (`model.safetensors`, etc.) and mmproj files are qualified by model name to avoid conflating different repos.

### Audit (`lib/audit/audit.ts` and friends)

The audit verifies on-disk files against HuggingFace: resolves each file at its commit, compares size/hash, detects updates, duplicates, and incomplete/invalid downloads, and writes the results back into the sidecars. Exposed through `app/api/v1/audit/*` and surfaced in the audit cells/columns of the models table.

### Downloads

HuggingFace downloads shell out to the `hf` CLI, which inherits the server's environment (`HF_TOKEN`, Xet acceleration via `HF_XET_HIGH_PERFORMANCE` — set in `.envrc` for dev and in the `Containerfile`); progress is tracked by polling bytes-on-disk (`lib/hf/hf-download*.ts`, `components/download-runner.tsx`). **Lemonade** is a separate model-server cache the app can browse and sync into (`lib/lemonade/`, `components/lemonade/`).

## UI conventions

- Buttons that open a modal or dialog end their label with an ellipsis (`…`) — e.g. `"Delete…"`, `"Copy to…"`.
- Import Astryx components by their bare names (`import {Button} from '@astryxdesign/core/Button'`) — never alias them (no `XDS*`-style prefixes).

<!-- ASTRYX:START -->

Astryx v0.7.17 · 174 components
CLI: run every command as `bunx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in app entry e.g. main.tsx) — without these, components render unstyled:
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";

WORKFLOW — start every page from a template, never from scratch:

1. `astryx build "<idea>"` — names the template to scaffold from and the parts it lacks.
2. `astryx template <name> <path>` — scaffold it; keep its frame, gap and padding; replace the content.
3. `astryx component <Name>` to read props before using one; `astryx template <Block>` prints a block example to read for a part it lacks. Astryx names differ from other libraries: buttons, badges, tokens and tabs take their text in `label` (Text, Heading and Link take children), booleans start with `is` or `has` (`isOpen`, `isDisabled`), and every input takes `value` and `onChange`.
   Changing an existing page? Keep it: skip step 2 and add components inside its sections; read a block example when it helps.
   Before you deliver a build, run `astryx doctor --built <dir>`; don't deliver it if it fails.

RULES:

- No <div> — components handle all layout and spacing.
- Read `astryx docs layout` before changing a template's frame.
- Dense data = rows (Table, List/Item), not Card-wrapped lists. Badge = counts only.
- Style with component props first, then the xstyle prop / StyleX tokens. No raw hex/px.
- THEMES: palettes and custom colors go through the theme, never :root overrides; so does a denser or roomier app (`editor set <name> spacing tight`), never gap and padding changes page by page. A change to one kind of part (the sidebar, its selected item, the gaps in a form) is a theme change too, not props on one page: `editor how "<ask>"` names the `set … --on <part>` line. No app yet: `astryx experimental theme preview app <dir>` makes a starter app that shows the theme. To make or change a theme (colors, fonts, corners, spacing, a look from a picture), prefer the experimental theme editor over hand-written theme files: `astryx experimental theme editor new <name> --like neutral`, then `editor set <name> <thing> <value>` or `editor how "<what you want>"`; wire it with `astryx theme add <name>`; after each change look at it with `astryx experimental theme editor show <name> --png` (takes pictures of real components) and open the PNGs it writes; a theme change is not done until you have looked at the pictures. In code, extend an imported theme to customize it; `theme eject <slug>` only forks source. See `astryx docs theme`.
- SELF-CHECK: re-read the file; replace any className=, style={{…}}, raw <div>/<span>, imported .css/@apply, or hardcoded #hex/px with the component or the xstyle prop + a token.

`astryx help` lists every command. Key ones beyond the workflow:
search "<query>" find any component / hook / doc / template
discover <words> integrations you could add
docs <topic> getting-started, principles, tokens, theme … (`astryx docs` lists all)
docs cli commands and API reference
docs authoring build an integration package, and every field it holds
upgrade --from <old version> --apply run after a dependency bump
To remove this block, run `astryx init --remove-agents`, which removes it from the agent files at the project root and in the folder you run it in; from any other file it leaves, delete everything from ASTRYX:START to ASTRYX:END.
<!-- ASTRYX:END -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
