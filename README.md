# pi-mcp-prompts

A [Pi](https://github.com/earendil-works/pi) extension that surfaces **MCP prompts**
(the `prompts/list` and `prompts/get` MCP primitives) inside the Pi terminal UI.

Pi's built-in MCP integration only exposes MCP **tools** and **resources** — it does
not support MCP **prompts** at all (see upstream issue
[earendil-works/pi#11439](https://github.com/earendil-works/pi/issues/11439),
auto-closed, no-action). This extension fills that gap.

It adds a single command, `/mcp-prompts`, that:

1. Reads the same `mcp.json` Pi uses (user-level `~/.pi/agent/mcp.json` and
   project-level `<cwd>/.pi/mcp.json`).
2. Connects to every enabled server (both `streamable-http` and `stdio` transports).
3. Lists all prompts offered across servers.
4. Lets you pick one, fills in any declared arguments, and loads the resulting
   prompt text into the input editor — ready to send.

## Why

MCP servers often ship useful "workflows" or "guides" as prompts. Without this
extension those prompts are invisible to Pi; the common workaround is to wrap them
in a tool like `read_guide`. `pi-mcp-prompts` makes the server's own prompts
first-class instead.

## Requirements

- Pi **≥ 1.0** (the extension API used here ships with it).
- Node.js **≥ 18** (only matters for the runtime that runs Pi; the extension itself
  uses only Node built-ins).
- Network/program access to your configured MCP servers.

## Installation

The extension is a single file with **zero dependencies** (only Node built-ins), so
the simplest install is to copy it into Pi's extensions directory.

### Option A — copy the file (recommended)

```bash
# user-level (available in every project)
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/jcleng/pi-mcp-prompts/main/mcp-prompts.ts \
  -o ~/.pi/agent/extensions/mcp-prompts.ts

# …or project-level (only this project, requires project trust)
mkdir -p .pi/extensions
curl -fsSL https://raw.githubusercontent.com/jcleng/pi-mcp-prompts/main/mcp-prompts.ts \
  -o .pi/extensions/mcp-prompts.ts
```

Restart Pi (or run `/reload`). That's it — no build step, no `npm install`.

### Option B — clone the repo

```bash
git clone https://github.com/jcleng/pi-mcp-prompts.git
# then symlink or copy mcp-prompts.ts into one of the extensions directories above
ln -s "$PWD/pi-mcp-prompts/mcp-prompts.ts" ~/.pi/agent/extensions/mcp-prompts.ts
```

## Usage

Inside an interactive Pi session:

1. Type `/mcp-prompts`.
2. A selector appears listing every prompt from every connected server, labelled
   `server › prompt-name — title (args: …)` when arguments are required.
3. Pick one. If the prompt declares arguments, you'll be prompted for each one
   (leave blank for optional arguments).
4. The prompt's text is loaded into the input editor. Press Enter to send it.

Example — with a server (e.g. `mcphub`) exposing prompts such as `online-search`,
`work_code`, `tools-read_xlsx`, running `/mcp-prompts` shows them all and drops the
chosen one into your editor.

## How it works

The extension implements a tiny, dependency-free MCP client:

- **`streamable-http`** servers (`mcp.json` entries with `url`): `fetch` +
  Server-Sent-Events / JSON parsing, with `mcp-session-id` header handling.
- **`stdio`** servers (`mcp.json` entries with `command`): spawns the process and
  speaks newline-delimited JSON-RPC.

It performs the standard handshake (`initialize` → `notifications/initialized`),
then `prompts/list` and `prompts/get`, and renders the returned message blocks into
editable text.

## Limitations

- Servers that require **OAuth** sign-in (e.g. Sentry) are not yet supported by this
  extension's client — use `pi`'s built-in `/mcp login` for those, and rely on their
  tools instead of prompts.
- `env` values may reference `${VAR}` (expanded from the process environment). The
  `!command` form from `mcp.json` is **not** interpreted.
- It does not register prompts as Pi slash commands or as model-callable tools; it is
  an interactive command only.

## License

MIT — see [LICENSE](./LICENSE).

## Related

- Upstream request for native support:
  [earendil-works/pi#11439](https://github.com/earendil-works/pi/issues/11439)
