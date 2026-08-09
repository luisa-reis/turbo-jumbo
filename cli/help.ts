export const HELP = `tj — Turbo Jumbo from the command line

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
  version             Server version, and the URL this CLI is pointed at
  help                This text

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
  --dry-run           Print the plan and stop

  Transfers never prompt. --delete-after must be typed, and --dry-run shows
  what would happen first. Downloads run on the server this CLI points at; to
  fetch onto another machine, point at it with --url.

REMOVING (rm, lemonade sync)
  --from local|cold|<peer>   Which copy rm deletes. Required: no default
  -y, --yes           Answer the confirmation ahead of time
  --dry-run           Show what would go, and stop

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
  -h, --help          Show this text

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
`;
