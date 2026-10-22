import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";

const manifest = JSON.parse(
  readFileSync(
    new URL("../extensions/ublock-lite/manifest.json", import.meta.url),
    "utf8",
  ),
);
const extensionId = createHash("sha256")
  .update(Buffer.from(manifest.key, "base64"))
  .digest("hex")
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));

try {
  const token =
    process.env.UBOL_MCP_TOKEN ??
    execFileSync(
      process.env.UBOL_CREDS_BIN ?? "creds",
      ["get", "browser-extensions/dev/ublock-mcp-token", "--no-newline"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 },
    );
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error("Invalid token");
  const port = Number(process.env.UBOL_MCP_PORT ?? 17374);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid port");
  const headers = { Authorization: `Bearer ${token}` };
  const health = async () => {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers,
        signal: AbortSignal.timeout(1000),
      });
    } catch (error) {
      if (
        (error as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED"
      )
        return false;
      throw new Error("Local server unavailable");
    }
    if (!response.ok) throw new Error("Local server rejected authentication");
    const data = await response.json();
    if (typeof data.extensionConnected !== "boolean")
      throw new Error("Unexpected local server");
    return true;
  };
  if (!(await health())) {
    const child = spawn(
      process.execPath,
      [new URL("../packages/ublock-mcp/main.ts", import.meta.url).pathname],
      {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          UBOL_MCP_TOKEN: token,
          UBOL_MCP_PORT: String(port),
          UBOL_EXTENSION_ID: process.env.UBOL_EXTENSION_ID ?? extensionId,
        },
      },
    );
    let startupFailed = false;
    child.on("error", () => {
      startupFailed = true;
    });
    child.unref();
    let ready = false;
    for (let attempt = 0; attempt < 30 && !startupFailed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (await health()) {
        ready = true;
        break;
      }
    }
    if (!ready) throw new Error("Local server startup failed");
  }
  process.stdout.write(JSON.stringify(headers));
} catch {
  process.stderr.write(
    "uBlock Origin Lite MCP: Keychain token or local server unavailable.\n",
  );
  process.exitCode = 1;
}
