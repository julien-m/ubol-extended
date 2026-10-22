void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
/* MCP transport is deliberately separate from native script persistence. */
let tmSocket;
let tmHeartbeat;
let tmAuthenticated = false;
let tmQueue = Promise.resolve();
const tmConfigKey = "browserExtensionsMcp";
async function tmConnect() {
  clearInterval(tmHeartbeat);
  tmAuthenticated = false;
  tmSocket?.close();
  tmSocket = undefined;
  if (chrome.extension.inIncognitoContext) return;
  const config = (await chrome.storage.local.get(tmConfigKey))[tmConfigKey];
  if (
    !config?.enabled ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(config.token || "") ||
    !Number.isInteger(config.port) ||
    config.port < 1024 ||
    config.port > 65535
  )
    return;
  const socket = (tmSocket = new WebSocket(
    `ws://127.0.0.1:${config.port}/bridge`,
  ));
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "auth", token: config.token }));
    tmHeartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "ping" }));
    }, 20000);
  };
  socket.onclose = () => {
    if (tmSocket === socket) {
      clearInterval(tmHeartbeat);
      tmAuthenticated = false;
    }
  };
  socket.onmessage = (event) => {
    let command;
    try {
      command = JSON.parse(event.data);
    } catch {
      socket.close();
      return;
    }
    if (command.type === "ready" && tmSocket === socket) {
      tmAuthenticated = true;
      return;
    }
    if (command.type !== "request" || typeof command.id !== "string") return;
    tmQueue = tmQueue.then(async () => {
      let response;
      try {
        response = {
          type: "response",
          id: command.id,
          result: await globalThis.TmMcpNative.dispatch(
            command.method,
            command.args,
          ),
        };
      } catch (error) {
        response = {
          type: "response",
          id: command.id,
          error: String(error.message || error),
        };
      }
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(response));
    });
  };
}
chrome.alarms.create("browser-extensions-mcp-reconnect", {
  periodInMinutes: 0.5,
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (
    alarm.name === "browser-extensions-mcp-reconnect" &&
    (!tmSocket || tmSocket.readyState === WebSocket.CLOSED)
  )
    void tmConnect();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[tmConfigKey]) void tmConnect();
});
chrome.runtime.onStartup.addListener(() => void tmConnect());
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.what !== "mcp:status") return false;
  if (
    sender.id !== chrome.runtime.id ||
    sender.url?.split("?")[0] !== chrome.runtime.getURL("mcp-options.html")
  )
    return false;
  sendResponse({
    connected: tmAuthenticated && tmSocket?.readyState === WebSocket.OPEN,
  });
  return false;
});
void tmConnect();
