# pi-mcp-prompts

A [Pi](https://github.com/earendil-works/pi) extension that surfaces **MCP prompts**
(the `prompts/list` and `prompts/get` MCP primitives) inside the Pi terminal UI.

Pi's built-in MCP integration only exposes MCP **tools** and **resources** — it does
not support MCP **prompts** at all (see upstream issue
[earendil-works/pi#11439](https://github.com/earendil-works/pi/issues/11439),
auto-closed, no-action). This extension fills that gap.

It adds a `/mcp-prompts` command (interactive TUI) and two model-callable tools
(`mcp_prompts_list`, `mcp_prompts_get`) that work in **every** mode — including
pi-web / RPC, where the interactive dialog is unavailable.

How it works: it reads the same `mcp.json` Pi uses (user-level `~/.pi/agent/mcp.json`
and project-level `<cwd>/.pi/mcp.json`), connects to every enabled server over both
`streamable-http` and `stdio` transports, and serves the servers' prompts via the
command (interactive) or the tools (model-driven, any mode).

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

### Interactive TUI (CLI)

Inside an interactive Pi terminal session:

1. Type `/mcp-prompts`.
2. A selector appears listing every prompt from every connected server, labelled
   `server › prompt-name — title (args: …)` when arguments are required.
3. Pick one. If the prompt declares arguments, you'll be prompted for each one
   (leave blank for optional arguments).
4. The prompt's text is loaded into the input editor. Press Enter to send it.

Example — with a server (e.g. `mcphub`) exposing prompts such as `online-search`,
`work_code`, `tools-read_xlsx`, running `/mcp-prompts` shows them all and drops the
chosen one into your editor.

### pi-web / RPC mode (no dialog UI)

pi-web runs sessions in **RPC mode**, whose client does not implement Pi's extension
dialog subprotocol (`select` / `input` windows). So the interactive `/mcp-prompts`
command is **TUI-only** there. Instead, the extension registers two
**model-callable tools** that work in every mode, including pi-web:

- **`mcp_prompts_list`** — lists the prompts offered by your configured MCP servers.
  Optional `server` argument restricts the listing. Returns a JSON array of
  `{ server, name, title, description, arguments }`.
- **`mcp_prompts_get`** — fetches the full text of one prompt. Arguments:
  `server` (required), `name` (required), `arguments` (optional object of argument
  name → value). Returns the rendered prompt text.

In pi-web, just ask the agent naturally, e.g.:

> “List the MCP prompts available.”
>
> “Use the `online-search` MCP prompt from `mcphub` and search for …”

The model calls `mcp_prompts_list` / `mcp_prompts_get` for you and uses the result
as instructions — no manual selection needed. These tools are also available in the
CLI if you prefer letting the model drive.

> Note: in non-TUI modes the `/mcp-prompts` command prints a hint to use the tools
> instead of opening a (non-functional) selector.

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
