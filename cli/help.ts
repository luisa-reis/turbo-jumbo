export const HELP = `tj — Turbo Jumbo from the command line

USAGE
  tj <command> [arguments] [options]

COMMANDS
  ls [pattern]        List models and quantizations, and where each is held
  where <model>       Show one model's quantizations and their locations
  disk [--all]        Free and total space on the model filesystems
  peers               Configured peers and whether each answers
  version             Server version, and the URL this CLI is pointed at
  help                This text

FILTERS (ls)
  --local             Only what this machine holds on fast storage
  --cold              Only what is in cold storage
  --peer <slug>       Only what the named peer holds

OPTIONS
  --format <f>        auto (default), table, json, or quiet
  --url <url>         Server to talk to
  -h, --help          Show this text

SERVER
  The server is found in this order: --url, then TJ_URL, then the local peer's
  address from config.yaml, then http://localhost:3000.

OUTPUT
  auto and table are the same thing; colour is dropped when output is not a
  terminal. Piping does not change the format — ask for --format json when a
  script needs to read it. quiet prints one identifier per line, for xargs.

EXIT CODES
  0  success
  1  error (bad usage, unreachable server, malformed config)
  2  reserved for findings

EXAMPLES
  tj ls qwen                      Models whose name contains "qwen"
  tj ls --cold                    Everything in cold storage
  tj where DeepSeek-V4-Flash      Where each quantization of it lives
  tj disk --all                   Space on this machine and every peer
  tj ls --format json | jq -r '.[] | select(.locations | length == 1) | .model'
`;
