import { WebSocket } from "ws";
import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
const token = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const extensionId = "a".repeat(32);
const running: ChildProcess[] = [];
const clients: Client[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const child of running.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Server shutdown timed out"));
      }, 1500);
      child.once("exit", (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error(`Server exited ${code}`));
      });
      child.send("stop");
    });
  }
});
async function setup(timeoutMs = 1000, ublock = false) {
  const node = Bun.which("node");
  if (!node) throw new Error("Node.js is required");
  const child = fork(new URL("./server-process.ts", import.meta.url), [], {
    execPath: node,
    env: {
      ...process.env,
      TEST_MCP_TOKEN: token,
      ...(ublock ? { TEST_UBOL: "1" } : {}),
      TEST_EXTENSION_ID: extensionId,
      TEST_TIMEOUT_MS: String(timeoutMs),
    },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  running.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    child.once("message", (message) =>
      resolve((message as { port: number }).port),
    );
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Startup failed ${code}`)));
  });
  return { base: `http://127.0.0.1:${port}` };
}
async function client(base: string) {
  const result = new Client({ name: "integration-test", version: "1.0.0" });
  clients.push(result);
  await result.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return result;
}
async function extension(
  base: string,
  onRequest?: (data: Record<string, unknown>, socket: WebSocket) => void,
) {
  const socket = new WebSocket(`${base.replace("http:", "ws:")}/bridge`, {
    headers: { Origin: `chrome-extension://${extensionId}` },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => socket.send(JSON.stringify({ type: "auth", token }));
    socket.onerror = () => reject(new Error("Socket failed"));
    socket.onmessage = (event) => {
      const data = JSON.parse(
        String((event as unknown as { data: unknown }).data),
      );
      if (data.type === "ready") resolve();
      else if (data.type === "request") onRequest?.(data, socket);
    };
  });
  return socket;
}
test("loopback server rejects missing token, browser Origin, query token and rebinding Host", async () => {
  const { base } = await setup();
  expect((await fetch(`${base}/health`)).status).toBe(401);
  expect(
    (
      await fetch(`${base}/health`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${base}/mcp`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://evil.com",
        },
      })
    ).status,
  ).toBe(403);
  expect((await fetch(`${base}/health?token=${token}`)).status).toBe(400);
  expect(
    (
      await fetch(`${base}/health`, {
        headers: { Host: "evil.com", Authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${base}/bridge`, { headers: { Origin: "https://evil.com" } }))
      .status,
  ).toBe(403);
});
test("MCP client initializes, discovers tools and forwards validated arguments", async () => {
  const { base } = await setup();
  const helperHeaders = JSON.parse(
    execFileSync(
      Bun.which("node")!,
      [new URL("../scripts/ublock-codex-headers.ts", import.meta.url).pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          UBOL_MCP_TOKEN: token,
          UBOL_MCP_PORT: new URL(base).port,
        },
      },
    ),
  );
  expect(helperHeaders).toEqual({ Authorization: `Bearer ${token}` });
  await extension(base, (request, socket) =>
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        result: { method: request.method, args: request.args },
      }),
    ),
  );
  const mcp = await client(base);
  expect(mcp.getServerVersion()?.name).toBe("tampermonkey mcp");
  const listed = await mcp.listTools();
  expect(listed.tools.map((tool) => tool.name)).toContain("script_put");
  expect(listed.tools.map((tool) => tool.name)).toContain("script_delete");
  expect(
    listed.tools.find((tool) => tool.name === "script_delete")?.annotations,
  ).toMatchObject({
    destructiveHint: true,
    idempotentHint: true,
    readOnlyHint: false,
  });
  expect(listed.tools.map((tool) => tool.name)).toContain("script_rerun");
  const result = await mcp.callTool({
    name: "script_get",
    arguments: { uuid: "abc" },
  });
  expect(JSON.stringify(result)).toContain("script_get");
  expect(JSON.stringify(result)).toContain("abc");
  const deletion = await mcp.callTool({
    name: "script_delete",
    arguments: { uuid: "abc" },
  });
  expect(deletion.isError).not.toBe(true);
  expect(
    JSON.parse((deletion.content as { type: string; text: string }[])[0]!.text),
  ).toEqual({ method: "script_delete", args: { uuid: "abc" } });
  for (const uuid of ["", null, "x".repeat(129)])
    expect(
      (await mcp.callTool({ name: "script_delete", arguments: { uuid } }))
        .isError,
    ).toBe(true);
  const invalid = await mcp.callTool({
    name: "script_rerun",
    arguments: { uuid: "abc", tabId: -1 },
  });
  expect(invalid.isError).toBe(true);
});
test("disconnected bridge and timeout produce errors, never successful mutations", async () => {
  const { base } = await setup(30);
  const mcp = await client(base);
  const disconnected = await mcp.callTool({
    name: "settings_get",
    arguments: {},
  });
  expect(disconnected.isError).toBe(true);
  await extension(base);
  const timeout = await mcp.callTool({
    name: "script_enabled_set",
    arguments: { uuid: "abc", enabled: false },
  });
  expect(timeout.isError).toBe(true);
  expect(JSON.stringify(timeout)).toContain("outcome unknown");
});
test("wrong WS token and competing authenticated bridge are rejected", async () => {
  const { base } = await setup();
  const wrong = new WebSocket(`${base.replace("http:", "ws:")}/bridge`, {
    headers: { Origin: `chrome-extension://${extensionId}` },
  });
  sockets.push(wrong);
  const code = await new Promise<number>((resolve) => {
    wrong.onopen = () =>
      wrong.send(JSON.stringify({ type: "auth", token: "incorrect" }));
    wrong.onclose = (event) => resolve(event.code);
  });
  expect(code).toBe(1008);
  await extension(base);
  const competitor = new WebSocket(`${base.replace("http:", "ws:")}/bridge`, {
    headers: { Origin: `chrome-extension://${extensionId}` },
  });
  sockets.push(competitor);
  const competitorCode = await new Promise<number>((resolve) => {
    competitor.onopen = () =>
      competitor.send(JSON.stringify({ type: "auth", token }));
    competitor.onclose = (event) => resolve(event.code);
  });
  expect(competitorCode).toBe(1008);
});

test.each([false, true])(
  "non-object WS JSON is rejected without crashing (authenticated=%s)",
  async (authenticated) => {
    const { base } = await setup();
    for (const value of [null, false, 42, "invalid", [], [null]]) {
      const socket = authenticated
        ? await extension(base)
        : new WebSocket(`${base.replace("http:", "ws:")}/bridge`, {
            headers: { Origin: `chrome-extension://${extensionId}` },
          });
      if (!authenticated) sockets.push(socket);
      const closed = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Invalid message was not rejected")),
          1000,
        );
        socket.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
        socket.once("error", reject);
      });
      if (authenticated) socket.send(JSON.stringify(value));
      else socket.once("open", () => socket.send(JSON.stringify(value)));
      expect(await closed).toBe(1008);
      expect(
        (
          await fetch(`${base}/health`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(200);
    }
    await extension(base, (request, socket) =>
      socket.send(
        JSON.stringify({ type: "response", id: request.id, result: "ok" }),
      ),
    );
    const mcp = await client(base);
    const result = await mcp.callTool({ name: "settings_get", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: '"ok"' }]);
  },
  10000,
);

// The shared transport must expose only the selected extension's contract.
test("uBlock MCP discovers its own tools and validates before dispatch", async () => {
  const { base } = await setup(1000, true);
  await extension(base, (request, socket) =>
    socket.send(
      JSON.stringify({ type: "response", id: request.id, result: request }),
    ),
  );
  const mcp = await client(base);
  expect(mcp.getServerVersion()?.name).toBe("ublock lite mcp");
  const names = (await mcp.listTools()).tools.map((tool) => tool.name);
  expect(names).toContain("filters_add");
  expect(names).toContain("elements_inspect");
  expect(names).not.toContain("script_put");
  const result = await mcp.callTool({
    name: "filters_add",
    arguments: { hostname: "example.org", selectors: ["aside"] },
  });
  expect(result.isError).not.toBe(true);
  const invalid = await mcp.callTool({
    name: "filters_add",
    arguments: { hostname: "example.org", selectors: [] },
  });
  expect(invalid.isError).toBe(true);
});
