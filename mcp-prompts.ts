/**
 * pi-mcp-prompts
 *
 * A zero-dependency Pi extension that surfaces MCP *prompts* (the `prompts/list`
 * and `prompts/get` MCP primitives) which Pi's built-in MCP support does not
 * expose. It registers a `/mcp-prompts` command that lets you browse the prompts
 * offered by every configured MCP server and drop the chosen prompt's text into
 * the input editor.
 *
 * Supports both transport types Pi's `mcp.json` accepts:
 *   - streamable-http  (config with `url`)
 *   - stdio            (config with `command`)
 *
 * See README.md for installation and usage.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Minimal MCP client (no external deps)
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "pi-mcp-prompts", version: "1.0.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}
interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Common surface for both transports. */
interface McpConnection {
  /** Send a request and resolve with the result. */
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void;
  close(): void;
}

function buildInitialize(clientInfo = CLIENT_INFO): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo,
    },
  };
}

// --- streamable-http transport -----------------------------------------------

class HttpConnection implements McpConnection {
  private sessionId?: string;
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new Error("MCP connection is closed");
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
    });
    if (this.sessionId === undefined) {
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const contentType = (res.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const raw = await res.text();
    const parsed = parseMcpBody(raw, contentType);
    const message = Array.isArray(parsed) ? parsed.find((m) => m.id === id) : parsed;
    if (!message) throw new Error(`MCP: no response for ${method}`);
    if (message.error) {
      throw new Error(`MCP error ${message.error.code}: ${message.error.message}`);
    }
    return message.result as T;
  }

  notify(method: string, params?: unknown): void {
    // Notifications expect no response; fire-and-forget the POST.
    void fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch(() => undefined);
  }

  close(): void {
    this.closed = true;
  }
}

/** Parse a streamable-http body that may be JSON or an SSE stream. */
function parseMcpBody(
  raw: string,
  contentType: string,
): JsonRpcResponse[] {
  if (contentType === "application/json") {
    return [JSON.parse(raw) as JsonRpcResponse];
  }
  // text/event-stream: events separated by blank lines, each `data:` line is a JSON object.
  const out: JsonRpcResponse[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data) continue;
      try {
        out.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        // ignore keep-alive / non-JSON SSE events
      }
    }
  }
  return out;
}

// --- stdio transport ---------------------------------------------------------

class StdioConnection implements McpConnection {
  private child: ReturnType<typeof spawn>;
  private buffer = "";
  private queue: { id: number; resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }[] = [];
  private nextId = 1;
  private closed = false;

  constructor(command: string, args: string[], env: Record<string, string>, cwd?: string) {
    this.child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("error", (err) => this.failAll(err));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (msg.id === undefined) continue; // notification: ignore
      const entry = this.queue.find((q) => q.id === msg.id);
      if (entry) {
        this.queue = this.queue.filter((q) => q !== entry);
        entry.resolve(msg);
      }
    }
  }

  private failAll(err: Error): void {
    for (const q of this.queue) q.reject(err);
    this.queue = [];
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("MCP connection is closed"));
    if (!this.child.stdin) return Promise.reject(new Error("MCP stdio stdin unavailable"));
    const id = this.nextId++;
    const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        resolve: (msg) => {
          if (msg.error) reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          else resolve(msg.result as T);
        },
        reject,
      });
      this.child.stdin!.write(JSON.stringify(body) + "\n");
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || !this.child.stdin) return;
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n",
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Server discovery (reads the same mcp.json Pi uses)
// ---------------------------------------------------------------------------

interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  enabled?: boolean;
  timeout?: number;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
}

function readJsonFile(path: string): McpConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
  } catch {
    return undefined;
  }
}

/** Collect enabled servers from user-level and project-level mcp.json. */
function loadServers(cwd: string): { name: string; entry: McpServerEntry }[] {
  const userPath = join(homedir(), ".pi", "agent", "mcp.json");
  const projectPath = join(cwd, ".pi", "mcp.json");
  const user = readJsonFile(userPath)?.mcpServers ?? {};
  const project = readJsonFile(projectPath)?.mcpServers ?? {};
  // project overrides same-named user servers
  const merged: Record<string, McpServerEntry> = { ...user, ...project };
  return Object.entries(merged)
    .filter(([, e]) => e.enabled !== false)
    .map(([name, entry]) => ({ name, entry }));
}

// ---------------------------------------------------------------------------
// Connect + list/get prompts
// ---------------------------------------------------------------------------

interface PromptDef {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

interface PromptContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}
interface PromptMessage {
  role: string;
  content: PromptContentBlock;
}

interface PromptGetResult {
  description?: string;
  messages: PromptMessage[];
}

function resolveEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    out[k] = v.replace(/\$\{(\w+)\}/g, (_, n) => process.env[n] ?? "");
  }
  return out;
}

async function connect(name: string, entry: McpServerEntry): Promise<McpConnection> {
  let conn: McpConnection;
  if (entry.url || entry.type === "http" || entry.type === "streamable-http") {
    const headers = resolveEnv(entry.headers);
    conn = new HttpConnection(entry.url!, headers);
  } else if (entry.command) {
    conn = new StdioConnection(
      entry.command,
      entry.args ?? [],
      resolveEnv(entry.env),
      entry.cwd,
    );
  } else {
    throw new Error(`server "${name}" has neither url nor command`);
  }
  await conn.request("initialize", buildInitialize().params);
  conn.notify("notifications/initialized");
  return conn;
}

async function listPrompts(conn: McpConnection): Promise<PromptDef[]> {
  const res = await conn.request<{ prompts?: PromptDef[] }>("prompts/list", {});
  return res.prompts ?? [];
}

async function getPrompt(
  conn: McpConnection,
  name: string,
  args: Record<string, string>,
): Promise<PromptGetResult> {
  return conn.request<PromptGetResult>("prompts/get", { name, arguments: args });
}

/** Flatten a prompt's messages into editable text. */
function renderPrompt(result: PromptGetResult, promptName: string): string {
  const parts: string[] = [];
  if (result.description) parts.push(`# ${result.description}`);
  for (const msg of result.messages ?? []) {
    const role = msg.role;
    const text = msg.content?.text ?? "";
    if (!text) continue;
    parts.push(`[${role}]\n${text}`);
  }
  return parts.join("\n\n").trim() || `(prompt "${promptName}" returned no text content)`;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("mcp-prompts", {
    description: "Browse MCP server prompts and load one into the editor",
    handler: async (_args, ctx) => {
      const servers = loadServers(ctx.cwd);
      if (servers.length === 0) {
        ctx.ui.notify("No enabled MCP servers found in mcp.json", "warning");
        return;
      }

      // Collect all (server, prompt) pairs, opening connections lazily.
      type Item = { server: string; prompt: PromptDef };
      const items: Item[] = [];
      const conns = new Map<string, McpConnection>();
      for (const { name, entry } of servers) {
        try {
          const conn = await connect(name, entry);
          conns.set(name, conn);
          const prompts = await listPrompts(conn);
          for (const p of prompts) items.push({ server: name, prompt: p });
        } catch (err) {
          ctx.ui.notify(`MCP "${name}": ${(err as Error).message}`, "warning");
        }
      }

      const closeAll = () => conns.forEach((c) => c.close());

      if (items.length === 0) {
        closeAll();
        ctx.ui.notify("No MCP prompts available from connected servers", "warning");
        return;
      }

      const labels = items.map((it) => {
        const title = it.prompt.title ?? it.prompt.description ?? it.prompt.name;
        const args = (it.prompt.arguments ?? []).length
          ? ` (args: ${(it.prompt.arguments ?? []).map((a) => a.name).join(", ")})`
          : "";
        return `${it.server} › ${it.prompt.name} — ${title}${args}`;
      });

      const choice = await ctx.ui.select("Select an MCP prompt", labels);
      if (!choice) {
        closeAll();
        return;
      }
      const idx = labels.indexOf(choice);
      const picked = items[idx];

      // Collect arguments from the user.
      const args: Record<string, string> = {};
      for (const arg of picked.prompt.arguments ?? []) {
        const answer = await ctx.ui.input(
          `Argument "${arg.name}"${arg.required ? " (required)" : ""}`,
          arg.description ?? "",
        );
        if (answer === undefined) {
          closeAll();
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        args[arg.name] = answer;
      }

      try {
        const result = await getPrompt(conns.get(picked.server)!, picked.prompt.name, args);
        const text = renderPrompt(result, picked.prompt.name);
        ctx.ui.setEditorText(text);
        ctx.ui.notify(`Loaded prompt "${picked.prompt.name}" from ${picked.server}`, "info");
      } catch (err) {
        ctx.ui.notify(`prompts/get failed: ${(err as Error).message}`, "error");
      } finally {
        closeAll();
      }
    },
  });
}
