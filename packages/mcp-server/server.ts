import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod/v4";

type BridgeSocket = WebSocket & { data: SocketData };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  socket: BridgeSocket;
};
type SocketData = {
  authenticated: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closingTimer?: ReturnType<typeof setTimeout>;
};
export type BridgeConfig = {
  token: string;
  port?: number;
  extensionId?: string;
  timeoutMs?: number;
  name?: string;
  tools?: readonly (readonly [string, string, z.ZodRawShape])[];
};
export function sameToken(actual: string, expected: string): boolean {
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startServer(config: BridgeConfig) {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(config.token))
    throw new Error("TM_MCP_TOKEN must have 32–128 URL-safe characters");
  if (config.extensionId && !/^[a-p]{32}$/.test(config.extensionId))
    throw new Error("Invalid extension ID");
  let active: BridgeSocket | undefined;
  const pending = new Map<string, Pending>();
  const transports = new Set<StreamableHTTPServerTransport>();

  const rejectSocket = (socket: BridgeSocket, reason: string) => {
    clearTimeout(socket.data.timer);
    socket.close(1008, reason);
    socket.data.closingTimer = setTimeout(() => socket.terminate(), 1000);
  };
  const execute = (method: string, args: Record<string, unknown>) =>
    new Promise<unknown>((resolve, reject) => {
      const socket = active;
      if (!socket?.data.authenticated) {
        reject(
          new Error(
            "Extension disconnected; enable MCP in the fork and start the bridge",
          ),
        );
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new Error(
            "Extension timed out; mutation outcome unknown, reread before retry",
          ),
        );
      }, config.timeoutMs ?? 15000);
      pending.set(id, { resolve, reject, timer, socket });
      socket.send(JSON.stringify({ type: "request", id, method, args }));
    });
  const createMcp = () => {
    const mcp = new McpServer({
      name: config.name ?? "tampermonkey mcp",
      version: "0.2.0",
    });
    const uuid = z.string().min(1).max(128);
    const definitions = [
      ["scripts_list", "Liste les scripts actifs et désactivés.", {}],
      ["script_get", "Lit le code source d’un script.", { uuid }],
      [
        "script_delete",
        "Déplace un script dans la corbeille native (mode Activé requis). Suppression récupérable, sans purge définitive ; une répétition confirme l’état déjà supprimé.",
        { uuid },
      ],
      [
        "script_put",
        "Crée ou remplace un userscript. Sans uuid : création.",
        { uuid: uuid.optional(), code: z.string().min(1).max(1000000) },
      ],
      [
        "script_enabled_set",
        "Active ou désactive un script.",
        { uuid, enabled: z.boolean() },
      ],
      ["script_options_get", "Lit les options d’un script.", { uuid }],
      [
        "script_options_set",
        "Modifie les options compatibles du script.",
        {
          uuid,
          options: z
            .object({
              run_at: z
                .enum([
                  "document-start",
                  "document-body",
                  "document-end",
                  "document-idle",
                  "context-menu",
                ])
                .nullable()
                .optional(),
              sandbox: z
                .enum(["raw", "JavaScript", "DOM"])
                .nullable()
                .optional(),
              check_for_updates: z.boolean().nullable().optional(),
              tags: z.array(z.string().max(128)).max(100).optional(),
            })
            .strict(),
        },
      ],
      [
        "script_storage_get",
        "Lit les valeurs GM du script sous forme typée.",
        { uuid },
      ],
      [
        "script_storage_set",
        "Écrit une valeur GM, ou retire la clé avec remove.",
        {
          uuid,
          key: z.string().min(1).max(512),
          value: z.json().optional(),
          remove: z.boolean().optional(),
        },
      ],
      ["settings_get", "Lit les paramètres globaux exposés (aucun token).", {}],
      [
        "setting_set",
        "Modifie un paramètre global exposé.",
        {
          name: z.enum([
            "enabled",
            "autoReload",
            "scriptUpdateAutomaticInstall",
            "scriptUpdateCheckPeriod",
            "notification_silentScriptUpdate",
            "logLevel",
          ]),
          value: z.union([z.boolean(), z.number().nonnegative()]),
        },
      ],
      [
        "script_rerun",
        "Recharge l’onglet ciblé si le script correspond. Tous les scripts correspondants de cet onglet redémarrent.",
        { uuid, tabId: z.number().int().nonnegative() },
      ],
    ] as const;
    for (const [name, description, inputSchema] of config.tools ??
      definitions) {
      mcp.registerTool(
        name,
        {
          description,
          inputSchema,
          ...(name === "script_delete"
            ? {
                annotations: {
                  readOnlyHint: false,
                  destructiveHint: true,
                  idempotentHint: true,
                  openWorldHint: false,
                },
              }
            : {}),
        },
        async (args: Record<string, unknown>) => {
          try {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    await execute(name, args as Record<string, unknown>),
                  ),
                },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text:
                    error instanceof Error ? error.message : "Bridge failure",
                },
              ],
            };
          }
        },
      );
    }
    return mcp;
  };
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 2000000 });
  let port = 0;
  const validHost = (request: IncomingMessage) =>
    [`127.0.0.1:${port}`, `localhost:${port}`].includes(
      request.headers.host ?? "",
    );
  const server = createServer(async (request, response) => {
    const end = (status: number, text: string) => {
      response.writeHead(status);
      response.end(text);
    };
    if (!validHost(request)) {
      end(403, "Invalid host");
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.search) {
      end(400, "Query parameters forbidden");
      return;
    }
    if (url.pathname === "/bridge") {
      end(403, "Expected authenticated extension WebSocket");
      return;
    }
    if (request.headers.origin) {
      end(403, "Browser origins forbidden on MCP endpoint");
      return;
    }
    if (
      !sameToken(
        request.headers.authorization?.replace(/^Bearer /, "") ?? "",
        config.token,
      )
    ) {
      response.setHeader("WWW-Authenticate", "Bearer");
      end(401, "Unauthorized");
      return;
    }
    if (url.pathname === "/health") {
      response.setHeader("Content-Type", "application/json");
      end(
        200,
        JSON.stringify({ extensionConnected: !!active?.data.authenticated }),
      );
      return;
    }
    if (url.pathname !== "/mcp") {
      end(404, "Not found");
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      end(405, "Method not allowed");
      return;
    }
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of request) {
        const buffer = Buffer.from(chunk);
        length += buffer.length;
        if (length > 1500000) {
          end(413, "Request too large");
          return;
        }
        chunks.push(buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      end(400, "Invalid JSON");
      return;
    }
    const mcp = createMcp();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    transports.add(transport);
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) end(500, "MCP request failed");
    } finally {
      await transport.close();
      await mcp.close();
      transports.delete(transport);
    }
  });
  server.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    if (
      !validHost(request) ||
      request.url !== "/bridge" ||
      !origin ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) ||
      (config.extensionId &&
        origin !== `chrome-extension://${config.extensionId}`)
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws),
    );
  });
  sockets.on("connection", (rawSocket) => {
    const socket = rawSocket as BridgeSocket;
    socket.data = { authenticated: false };
    socket.data.timer = setTimeout(
      () => rejectSocket(socket, "Authentication timeout"),
      5000,
    );
    socket.on("error", () => socket.terminate());
    socket.on("message", (message) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(String(message));
      } catch {
        rejectSocket(socket, "Invalid JSON");
        return;
      }
      if (!socket.data.authenticated) {
        if (
          data.type !== "auth" ||
          typeof data.token !== "string" ||
          !sameToken(data.token, config.token)
        ) {
          rejectSocket(socket, "Invalid authentication");
          return;
        }
        clearTimeout(socket.data.timer);
        if (active && active !== socket) {
          rejectSocket(socket, "Another extension is already connected");
          return;
        }
        socket.data.authenticated = true;
        active = socket;
        socket.send(JSON.stringify({ type: "ready" }));
        return;
      }
      if (data.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (data.type !== "response" || typeof data.id !== "string") return;
      const operation = pending.get(data.id);
      if (!operation || operation.socket !== socket) return;
      clearTimeout(operation.timer);
      pending.delete(data.id);
      if (typeof data.error === "string")
        operation.reject(new Error(data.error));
      else operation.resolve(data.result);
    });
    socket.on("close", () => {
      clearTimeout(socket.data.timer);
      clearTimeout(socket.data.closingTimer);
      if (active === socket) active = undefined;
      for (const [id, operation] of pending)
        if (operation.socket === socket) {
          clearTimeout(operation.timer);
          pending.delete(id);
          operation.reject(
            new Error("Extension disconnected; mutation outcome unknown"),
          );
        }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port ?? 17373, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Server did not bind a TCP port");
  port = address.port;
  return {
    server: { port },
    async stop() {
      for (const transport of transports) await transport.close();
      for (const raw of sockets.clients) {
        const socket = raw as BridgeSocket;
        clearTimeout(socket.data.timer);
        clearTimeout(socket.data.closingTimer);
        socket.terminate();
      }
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
