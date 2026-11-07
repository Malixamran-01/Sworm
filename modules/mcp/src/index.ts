import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { NodeCallError, type CallContext, type ToolInfo } from "@conclave/contract";
import { defineModule, requireString, statusForError, type ModuleContext } from "@conclave/module-sdk";

/**
 * Protocol dock (MOD-004): any MCP server reachable over Streamable HTTP or SSE
 * becomes a Tool-port node, through the official MCP TypeScript SDK. stdio
 * servers on a user's machine arrive with the Local Bridge (SRS 8.8).
 */
export default defineModule({
  manifest: {
    id: "conclave/mcp",
    version: "0.1.0",
    name: "MCP server",
    description: "Any Model Context Protocol server over Streamable HTTP or SSE. Its tools become steps your workflows can call.",
    ports: ["tool@1"],
    docks: ["protocol"],
    config: [
      { key: "url", label: "Server URL", type: "url", required: true, placeholder: "https://example.com/mcp" },
      { key: "token", label: "Bearer token", type: "secret", required: false, help: "Sent as Authorization: Bearer. Leave empty for open servers." },
      { key: "transport", label: "Transport", type: "string", required: false, default: "auto", help: "auto, streamable-http or sse." },
      { key: "pricePerCallUsd", label: "Price per call (USD)", type: "number", required: false, default: 0, help: "For paid tools. Used for budgets (COST-004)." },
    ],
    permissions: { egress: ["{config.url}"], secrets: ["token"] },
    outsideVersions: { "mcp-protocol": ">=2025-03-26" },
    reference: true,
  },
  create(ctx) {
    const mcp = new McpConnection(ctx);
    return {
      ports: {
        tool: {
          listTools: () => mcp.listTools(),
          call: (name, args, call) => mcp.call(name, args, call),
        },
      },
      async health(signal) {
        try {
          const tools = await mcp.listTools(signal);
          return { status: "working", detail: `${tools.length} tool(s) available.` };
        } catch (err) {
          return statusForError(err);
        }
      },
      async outsideVersion() {
        await mcp.client();
        return mcp.serverVersion;
      },
      async discover(signal) {
        const tools = await mcp.listTools(signal);
        return { tools: tools.map((t) => ({ name: t.name })) };
      },
      close: () => mcp.close(),
    };
  },
});

class McpConnection {
  private readonly ctx: ModuleContext;
  private connecting: Promise<Client> | undefined;
  serverVersion: string | null = null;

  constructor(ctx: ModuleContext) {
    this.ctx = ctx;
  }

  private get url(): URL {
    return new URL(requireString(this.ctx.config.url, "Server URL"));
  }

  private get requestInit(): RequestInit {
    return this.ctx.secrets.token ? { headers: { authorization: `Bearer ${this.ctx.secrets.token}` } } : {};
  }

  /** One client per instance, reconnected after a failure; MCP sessions are reused, not reopened per call (SRS 11.2). */
  client(): Promise<Client> {
    this.connecting ??= this.connect().catch((err) => {
      this.connecting = undefined;
      throw mapError(err);
    });
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const mode = String(this.ctx.config.transport ?? "auto");
    const fetchImpl = this.ctx.fetch;
    const tryStreamable = async () => {
      const client = new Client({ name: "conclave", version: "0.1.0" });
      await client.connect(new StreamableHTTPClientTransport(this.url, { requestInit: this.requestInit, fetch: fetchImpl }));
      return client;
    };
    const trySse = async () => {
      const client = new Client({ name: "conclave", version: "0.1.0" });
      await client.connect(new SSEClientTransport(this.url, { requestInit: this.requestInit, fetch: fetchImpl }));
      return client;
    };
    let client: Client;
    if (mode === "sse") client = await trySse();
    else if (mode === "streamable-http") client = await tryStreamable();
    else {
      // Streamable HTTP first; older servers only speak SSE.
      try {
        client = await tryStreamable();
      } catch {
        client = await trySse();
      }
    }
    const info = client.getServerVersion();
    this.serverVersion = info ? `${info.name} ${info.version}` : null;
    return client;
  }

  async listTools(signal?: AbortSignal): Promise<ToolInfo[]> {
    const client = await this.client();
    try {
      const tools: ToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, signal ? { signal } : undefined);
        for (const t of page.tools) {
          tools.push({
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown>,
            // Anything that is not declared read-only counts as a write, and writes are sensitive until reviewed (SRS 5.1).
            sensitive: t.annotations?.readOnlyHint !== true,
          });
        }
        cursor = page.nextCursor;
      } while (cursor && tools.length < 1_000);
      return tools;
    } catch (err) {
      throw this.failed(err);
    }
  }

  async call(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<{ data: unknown }> {
    if (ctx.signal.aborted) throw new NodeCallError("cancelled", "The call was cancelled.", false);
    if (!name) throw new NodeCallError("invalid_request", "A tool name is required.", false);
    const client = await this.client();
    try {
      const result = await client.callTool({ name, arguments: args }, undefined, { signal: ctx.signal, timeout: 300_000 });
      if (result.isError) {
        const text = textOf(result.content);
        throw new NodeCallError("invalid_request", `The tool reported an error: ${text.slice(0, 500) || "no details"}`, false);
      }
      return { data: { text: textOf(result.content), structured: result.structuredContent ?? null } };
    } catch (err) {
      throw this.failed(err);
    }
  }

  /** A failed transport is dropped so the next call reconnects. */
  private failed(err: unknown): NodeCallError {
    const mapped = mapError(err);
    if (mapped.code === "unavailable" || mapped.code === "timeout") void this.close();
    return mapped;
  }

  async close(): Promise<void> {
    const pending = this.connecting;
    this.connecting = undefined;
    if (pending) await (await pending.catch(() => null))?.close().catch(() => {});
  }
}

/** The text parts of an MCP result, joined. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string; resource?: { text?: string } }) => (c.type === "text" ? (c.text ?? "") : c.type === "resource" ? (c.resource?.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function mapError(err: unknown): NodeCallError {
  if (err instanceof NodeCallError) return err;
  const e = err as { name?: string; message?: string; code?: number };
  const message = e?.message ?? String(err);
  if (e?.name === "AbortError" || /aborted/i.test(message)) return new NodeCallError("cancelled", "The call was cancelled.", false);
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden/i.test(message)) return new NodeCallError("auth", `The MCP server refused the credentials: ${message}`, false);
  if (/\b429\b/.test(message)) return new NodeCallError("rate_limited", message, true);
  if (/timed? ?out/i.test(message)) return new NodeCallError("timeout", message, true);
  if (/not found|unknown tool|-32601|-32602/i.test(message)) return new NodeCallError("invalid_request", message, false);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|network|\b5\d\d\b/i.test(message)) return new NodeCallError("unavailable", `Could not reach the MCP server: ${message}`, true);
  return new NodeCallError("internal", message, false);
}
