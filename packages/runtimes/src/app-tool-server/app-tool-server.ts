import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { RuntimeAppTool } from "@rack/core/execution/app-tools";

/** Run-scoped, authenticated, stateless Streamable HTTP MCP transport.
 * Both providers use their supported MCP configuration, including resumed
 * sessions. A random token and loopback listener prevent a webpage/other
 * session from invoking tools. No provider credentials are served here.
 */
export async function startAppToolServer(tools: readonly RuntimeAppTool[], signal: AbortSignal): Promise<{
  url: string; token: string; close(): Promise<void>;
} | undefined> {
  if (tools.length === 0) return undefined;
  if (signal.aborted) throw new Error("Run was interrupted before tools could start.");
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp" || request.headers.authorization !== `Bearer ${token}` || request.headers.origin !== undefined) { response.writeHead(403).end(); return; }
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let id: unknown;
    const reply = (payload: unknown) => { if (!response.writableEnded) response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(payload)); };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 1_048_576) throw new Error("Tool request is too large.");
        chunks.push(bytes);
      }
      // Decode once: streamed HTTP chunks can split a UTF-8 character.
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
      id = message.id;
      if (id === undefined) { response.writeHead(202).end(); return; }
      let result: unknown;
      if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "rack", version: "1.0.0" } };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list") result = { tools: tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
      else if (message.method === "tools/call") {
        const tool = tools.find((candidate) => candidate.name === message.params?.name);
        if (tool === undefined || signal.aborted) throw new Error("Tool is unavailable for this run.");
        try { result = { content: [{ type: "text", text: await tool.execute(message.params?.arguments ?? {}) }] }; }
        catch (error) { result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
      } else { reply({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not supported." } }); return; }
      reply({ jsonrpc: "2.0", id, result });
    } catch (error) { reply({ jsonrpc: "2.0", id: id ?? null, error: { code: -32602, message: error instanceof Error ? error.message : String(error) } }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Could not open the app tool transport.");
  let closing: Promise<void> | undefined;
  const abort = () => { void close(); };
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve) => {
      signal.removeEventListener("abort", abort);
      server.closeAllConnections();
      server.close(() => resolve());
    });
    return closing;
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) { await close(); throw new Error("Run was interrupted while tools were starting."); }
  return { url: `http://127.0.0.1:${address.port}/mcp`, token, close };
}
