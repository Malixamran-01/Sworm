import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { NodeCallError } from "@conclave/contract";
import { runConformance, testCallContext } from "@conclave/module-sdk/conformance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import mcp from "./index";

/** A real MCP server over Streamable HTTP, in this process. */
let server: Server;
let url = "";
let lastAuth: string | undefined;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    lastAuth = req.headers.authorization;
    const mcpServer = new McpServer({ name: "test-tools", version: "1.2.3" });
    mcpServer.registerTool(
      "search",
      { description: "Search the test index", inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } },
      async ({ q }) => ({ content: [{ type: "text", text: `3 results for ${q}` }] }),
    );
    mcpServer.registerTool("broken", { description: "Always fails", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "index offline" }] }));
    // Stateless: a fresh transport per request.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close());
    await mcpServer.connect(transport);
    let body = "";
    for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const ctx = (config: Record<string, string | number> = {}, secrets: Record<string, string> = {}) => ({
  config: { url, transport: "streamable-http", ...config },
  secrets,
  fetch,
  log: { info() {}, warn() {} },
});

describe("MCP protocol dock", () => {
  it("passes the conformance kit against a real MCP server", async () => {
    const report = await runConformance(mcp, { config: { url, transport: "streamable-http" }, tool: "search", toolArgs: { q: "heat pumps" } });
    expect(report.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("lists tools with schemas and marks writes as sensitive", async () => {
    const instance = mcp.create(ctx());
    const tools = await instance.ports.tool!.listTools();
    expect(tools.map((t) => [t.name, t.sensitive])).toEqual([
      ["search", false],
      ["broken", true],
    ]);
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object", properties: { q: { type: "string" } } });
    expect(await instance.outsideVersion!()).toBe("test-tools 1.2.3");
    await instance.close!();
  });

  it("calls a tool, sends the bearer token, and reports tool errors", async () => {
    const instance = mcp.create(ctx({}, { token: "t-123" }));
    const result = await instance.ports.tool!.call("search", { q: "solar" }, testCallContext());
    expect(result.data).toMatchObject({ text: "3 results for solar" });
    expect(lastAuth).toBe("Bearer t-123");

    const err = await instance.ports.tool!.call("broken", {}, testCallContext()).catch((e) => e);
    expect(err).toBeInstanceOf(NodeCallError);
    expect(err.message).toMatch(/index offline/);
    await instance.close!();
  });

  it("reports an unreachable server as unavailable", async () => {
    const instance = mcp.create({ ...ctx(), config: { url: "http://127.0.0.1:1/mcp", transport: "streamable-http" } });
    const health = await instance.health();
    expect(health.status).toBe("unreachable");
  });
});
