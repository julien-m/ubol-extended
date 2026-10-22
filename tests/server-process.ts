import { tools } from "../packages/ublock-mcp/tools.ts";
import { startServer } from "../packages/mcp-server/server.ts";
const bridge = await startServer({
  token: process.env.TEST_MCP_TOKEN!,
  ...(process.env.TEST_UBOL ? { name: "ublock lite mcp", tools } : {}),
  port: 0,
  extensionId: process.env.TEST_EXTENSION_ID,
  timeoutMs: Number(process.env.TEST_TIMEOUT_MS ?? 1000),
});
process.send?.({ port: bridge.server.port });
process.on("message", async (message) => {
  if (message === "stop") {
    await bridge.stop();
    process.exit(0);
  }
});
