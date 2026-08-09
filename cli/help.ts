import {COMMANDS, type Command} from '@/lib/cli/args';

/**
 * Every help text `tj` can print.
 *
 * Three of them, on purpose. `-h` is the screenful you type to remember a
 * command's name; `--help` is the same ground with the reasons filled in; and
 * `tj <command> --help` is one command alone, because nobody reading about
 * `rm` needs the transfer flags scrolling past first.
 */

export const SHORT_HELP = `tj — Turbo Jumbo from the command line

USAGE
  tj <command> [arguments] [options]

COMMANDS
  ls [pattern]        List models and quantizations, and where each is held
  where <model>       Show one model's quantizations and their locations
  disk [--all]        Free and total space on the model filesystems
  peers               Configured peers and whether each answers
  get <repo|url>      Download from Hugging Face
  copy <model>        Copy between local, cold storage and peers
  audit <model>|--all Verify files against Hugging Face
  rm <model>          Delete a model's files from one storage tier
  lemonade ls|get|sync  Browse the Lemonade catalog, download from it, or
                      reconcile its cache
  version             Server and CLI versions, and the URL this CLI points at
  help [command]      This text, or one command in detail

OPTIONS
  --output-format <f> table (default), json, csv, toon, or lines
  --url <url>         Server to talk to
  -n, --dry-run       Print the plan and stop
  -h, --help          Print help (see more with '--help')

  tj <command> --help describes one command. tj --help-all prints them all.
`;

export const FULL_HELP = `tj — Turbo Jumbo from the command line

USAGE
  tj <command> [arguments] [options]

COMMANDS
  ls [pattern]        List models and quantizations, and where each is held
  where <model>       Show one model's quantizations and their locations
  disk [--all]        Free and total space on the model filesystems
  peers               Configured peers and whether each answers
  get <repo|url>      Download from Hugging Face
  copy <model>        Copy between local, cold storage and peers
  audit <model>|--all Verify files against Hugging Face; exit 3 on findings
  rm <model>          Delete a model's files from one storage tier
  lemonade ls|get|sync  Browse the Lemonade catalog, download from it, or
                      reconcile its cache
  version             Server and CLI versions, and the URL this CLI points at
  help [command]      This text, or one command in detail

FILTERS (ls)
  --local             Only what this machine holds on fast storage
  --cold              Only what is in cold storage
  --peer <slug>       Only what the named peer holds

TRANSFERS (get, copy)
  --quant <label>     Which quantization; repeatable. Omit on get to list them
  --file <path>       Individual repo files instead of a whole quantization
  --exact             With --file on get: the named files are the whole model,
                      not part of a bigger repo
  --to cold|<peer>    Where it ends up. get takes cold; copy takes either
  --from local|cold|<peer>   Where copy reads from (default: wherever it is)
  --delete-after      Remove the source once the copy is verified
  -n, --dry-run       Print the plan and stop

  Transfers never prompt. --delete-after must be typed, and --dry-run shows
  what would happen first. Downloads run on the server this CLI points at; to
  fetch onto another machine, point at it with --url.

REMOVING (rm, lemonade sync)
  --from local|cold|<peer>   Which copy rm deletes. Required: no default
  -y, --yes           Answer the confirmation ahead of time
  -n, --dry-run       Show what would go, and stop

  These two ask before deleting, naming what will go; type "yes" to agree.
  With no terminal to ask (cron, redirected input) they refuse instead, so
  --yes is what an unattended run needs.

AUDIT
  --cached            Last-known verdicts from sidecars: instant, no hashing
  --fix               Relocate misplaced files into their proper layout
  --allow-delete      Also resolve duplicates, which DELETES extra copies
  --cold, --peer <s>  Audit cold storage, or a peer, instead of local storage

  A fresh audit reads every byte of every file it checks, so it needs a model
  name or --all rather than defaulting to everything.

OPTIONS
  --output-format <f> table (default), json, csv, toon, or lines
  --url <url>         Server to talk to
  --color <when>      auto (default), always, never
  -v, --verbose       Say what is being done; repeat for more (-vv, -vvv)
  -q, --silent        Errors only. --quiet is accepted, for other tools' sake
  -h, --help          Print help; -h alone prints the summary
  --help-all          Every command's help at once
  --version           This CLI's version; add -v for the build detail

VERBOSITY
  One dial: --silent, then the default, then -v, -vv, -vvv. -v says what is
  being done, -vv adds each request and how long it took, -vvv adds the
  bodies. Every line is tagged with the level that produced it and goes to
  stderr, so turning the noise up never changes what a script reads from
  stdout. Asking for --silent and -v at once is an error, not a guess.

SERVER
  The server is found in this order: --url, then TJ_URL, then the local peer's
  address from config.yaml, then http://localhost:3000.

OUTPUT
  table is the default and the only one meant for a person; colour is dropped
  when output is not a terminal, and never appears in a machine format.
  Piping does not change the format — ask for --output-format json when a
  script needs to read it. csv and toon carry the same fields as json: csv for
  a spreadsheet, toon for feeding a model without paying for JSON's braces.
  lines prints one identifier per line, for xargs. A command whose answer is
  not records — a single version, say — has no csv form and says so.

EXIT CODES
  0  success
  1  error (unreachable server, malformed config, nothing matched)
  2  bad usage — an unknown flag, a missing argument
  3  the audit ran and found something — distinct from failing to run

EXAMPLES
  tj ls qwen                      Models whose name contains "qwen"
  tj ls --cold                    Everything in cold storage
  tj where DeepSeek-V4-Flash      Where each quantization of it lives
  tj disk --all                   Space on this machine and every peer
  tj get unsloth/Qwen3-8B-GGUF    List that repo's quantizations
  tj get unsloth/Qwen3-8B-GGUF --quant Q4_K_M
  tj copy Qwen3-8B --to cold --dry-run
  tj ls --output-format json | jq -r '.[] | select(.locations | length == 1) | .model'

  Worked examples for every command: docs/cli.md
`;

/**
 * One command's help: the whole story for that command and nothing about any
 * other. The global options are one `tj --help` away.
 */
const PER_COMMAND: Record<Command, string> = {
  ls: `tj ls [pattern] — list models and quantizations

Every model and quantization, and everywhere each one is held. WHERE reads
local for this machine's fast storage, cold for cold storage, and a peer's
slug for a peer; cold(partial) means an interrupted transfer, not something
you could restore from.

  [pattern]           Case-insensitive substring of the model name
  --local             Only what this machine holds on fast storage
  --cold              Only what is in cold storage
  --peer <slug>       Only what the named peer holds

An unreachable peer is skipped rather than reported as not having something:
"I could not ask" and "it is not there" are different answers, and only
tj peers is in a position to tell them apart.

  tj ls qwen
  tj ls --cold
  tj ls --peer rio --output-format lines
`,

  where: `tj where <model> — locate one model's quantizations

For when you know you have something and want to know which disk it is on.
The argument is a substring, so it need not be exact; matching more than one
model adds a MODEL column, and matching none exits 1.

  tj where DeepSeek-V4-Flash
`,

  disk: `tj disk [--all] — free and total space on the model filesystems

  --all               Include every peer, not just this machine

Models and cold storage are listed separately, except when they share a
filesystem — then one models+cold row, because their free space is a single
pool and listing it twice would imply twice the headroom you have.

  tj disk --all
`,

  peers: `tj peers — the configured peers, and whether each answers

Each peer is probed. A peer being down is reported, not raised: the command
still exits 0, because "that machine is off" is an answer.

  tj peers
`,

  get: `tj get <repo|url> — download from Hugging Face

The argument is anything the download modal accepts: a bare org/repo, a repo
URL, a folder URL, or a file URL. Asked for a repo and nothing else, it prints
the quantizations rather than guessing which one you meant.

  --quant <label>     Which quantization; repeatable
  --file <path>       Individual repo files instead of a whole quantization
  --exact             With --file: the named files are the whole model, not
                      part of a bigger repo
  --to cold           Archive to cold storage after downloading
  --delete-after      Remove the local copy once archived
  -n, --dry-run       Print the plan and stop

Downloads run on the server this CLI points at; to fetch onto another machine,
point at it with --url.

  tj get unsloth/Qwen3-8B-GGUF
  tj get unsloth/Qwen3-8B-GGUF --quant Q4_K_M --to cold
`,

  copy: `tj copy <model> — copy between local, cold storage and peers

Copies files you already have. There is no push or pull: --from and --to cover
both directions. Files the destination already holds an identical copy of are
left alone, so re-running an interrupted copy sends what is missing rather
than the whole model again.

  --to cold|<peer>    Where it ends up. Required
  --from local|cold|<peer>   Where to read from (default: wherever it is)
  --quant <label>     Which quantization; repeatable
  --delete-after      Remove the source once the copy is verified
  -n, --dry-run       Print the plan and stop

Matching more than one model stops rather than copying the wrong hundred
gigabytes.

  tj copy Qwen3-8B --to cold --dry-run
`,

  audit: `tj audit <model>|--all — verify files against Hugging Face

Reports what does not match, and exits 3 when it finds something — distinct
from 1, which means it could not check at all. A monitoring job can tell a
corrupted archive from an unreachable one.

  --all               Every model, rather than one named
  --cached            Last-known verdicts from sidecars: instant, no hashing
  --fix               Relocate misplaced files into their proper layout
  --allow-delete      Also resolve duplicates, which DELETES extra copies
  --cold              Audit cold storage instead of local storage
  --peer <slug>       Audit a peer instead of local storage
  -n, --dry-run       List what would be hashed, and how much

A fresh audit reads every byte of every file it checks, which is why it wants
a model name or --all rather than defaulting to everything. A run that repairs
everything it found exits 0: nothing is wrong any more.

  tj audit --all --cached
  tj audit Qwen3-8B --fix
`,

  rm: `tj rm <model> — delete a model's files from one storage tier

  --from local|cold|<peer>   Which copy goes. Required: no default
  --quant <label>     Only these quantizations; repeatable
  -y, --yes           Answer the confirmation ahead of time
  -n, --dry-run       Show what would go, and stop

--from has no default because a defaulted tier is how you delete the archived
copy while meaning the local one. It asks before deleting, naming what is
about to go, and only ever asks a terminal: with input redirected it refuses
and tells you to pass --yes, rather than waiting on an answer nobody is there
to give.

  tj rm Qwen3-8B --from local --dry-run
`,

  lemonade: `tj lemonade ls|get|sync — the Lemonade catalog

  ls                  The catalog, with what you already hold marked on it
  get <model>         Download a catalog model
  sync                Reconcile Lemonade's cache with Turbo Jumbo's storage

  -n, --dry-run       Show what sync would do, and stop
  -y, --yes           Answer sync's confirmation ahead of time

ls covers the whole catalog, not only its GGUF models: vLLM, ONNX, image,
speech and TTS entries are there too, with a RECIPE column telling them apart.
sync deletes, so it asks first, on the same terms as tj rm.

  tj lemonade ls
  tj lemonade sync --dry-run
`,

  version: `tj version — the server's version, the CLI's, and where it points

The URL is part of the answer on purpose: the commonest confusion with a
client tool is being pointed at a different machine than you assumed. Both
versions are listed because a client and server that have drifted apart is
exactly when you want to see the two side by side.

For this CLI alone — answered without reaching for a server at all — use
tj --version, and add -v for the commit and build detail.

  tj version
`,

  help: `tj help [command] — this help

  tj help              The full help
  tj -h                The summary
  tj help <command>    One command in detail
  tj --help-all        Every command's help at once
`,
};

/** One command's help, or undefined when the name isn't a command. */
export function commandHelp(name: string): string | undefined {
  return (COMMANDS as readonly string[]).includes(name)
    ? PER_COMMAND[name as Command]
    : undefined;
}

/** Every command's help at once, for reading or grepping in one go. */
export function helpAll(): string {
  return [FULL_HELP, ...COMMANDS.map((c) => PER_COMMAND[c])].join('\n');
}
