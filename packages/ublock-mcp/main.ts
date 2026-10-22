import { startServer } from "../mcp-server/server.ts";
import { tools } from "./tools.ts";

const token = process.env.UBOL_MCP_TOKEN;
if (!token) throw new Error("UBOL_MCP_TOKEN missing; load it from Keychain");
const port = Number(process.env.UBOL_MCP_PORT ?? 17374);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid UBOL_MCP_PORT");
const extensionId = process.env.UBOL_EXTENSION_ID;
if (!extensionId) throw new Error("UBOL_EXTENSION_ID required");
const bridge = await startServer({
  token,
  port,
  extensionId,
  tools,
  name: "ubol-extended",
  timeoutMs: 75000,
});
console.log(`uBlock MCP listening on http://127.0.0.1:${port}/mcp`);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await bridge.stop();
    process.exit(0);
  });
}
