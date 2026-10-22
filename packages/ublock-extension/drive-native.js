import { browser, runtime } from "./ext.js";
import { backupToObject, restoreFromObject } from "./backup-restore.js";
import { createDriveApi, createSync } from "./drive-sync.js";

const CONFIG = "ubolDriveConfig";
const STATE = "ubolDriveState";
const BACKUP = "ubolDriveBeforeRestore";
const ALARM = "ubol-drive-sync";
const SCOPE = "https://www.googleapis.com/auth/drive.appdata";

export function createDriveNative({ ready, request }) {
  let queue = Promise.resolve();
  const read = async (key) => (await browser.storage.local.get(key))[key] ?? {};
  async function getToken(interactive = false) {
    if (runtime.getURL("").startsWith("safari-web-extension:")) {
      const result = await runtime.sendNativeMessage("local.ublock-lite", {
        type: "driveToken",
      });
      if (!result?.token)
        throw new Error("Open the iPhone app to connect Google Drive");
      return result.token;
    }
    if (!runtime.getManifest().oauth2?.client_id)
      throw new Error(
        "Google OAuth client for this fork is not configured; see installation guide",
      );
    const result = await browser.identity.getAuthToken({
      interactive,
      scopes: [SCOPE],
    });
    const token = typeof result === "string" ? result : result?.token;
    if (!token) throw new Error("Google connection required");
    return token;
  }
  const sync = createSync({
    api: createDriveApi({ getToken }),
    snapshot: async () =>
      backupToObject(await request({ what: "getOptionsPageData" }), request),
    restore: (data) => restoreFromObject(data, request),
    readState: () => read(STATE),
    writeState: (state) => browser.storage.local.set({ [STATE]: state }),
    backup: (snapshot) =>
      browser.storage.local.set({
        [BACKUP]: { savedAt: new Date().toISOString(), snapshot },
      }),
  });
  function enqueue(operation) {
    const result = queue
      .catch(() => {})
      .then(async () => {
        await ready;
        return operation();
      });
    queue = result;
    return result;
  }
  async function run(mode, revision) {
    try {
      const result = await sync.run(mode, revision);
      await browser.storage.local.set({ uboldriveLastResult: result });
      return result;
    } catch (error) {
      await browser.storage.local.set({
        uboldriveLastResult: { error: String(error.message || error) },
      });
      throw error;
    }
  }
  browser.alarms.create(ALARM, { periodInMinutes: 15 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return;
    void enqueue(async () => {
      if ((await read(CONFIG)).enabled) await run("sync");
    }).catch(() => {});
  });
  async function operate(message) {
    switch (message.what) {
      case "drive:status":
        return {
          config: await read(CONFIG),
          state: await read(STATE),
          result: await read("uboldriveLastResult"),
          oauthConfigured:
            runtime.getURL("").startsWith("safari-web-extension:") ||
            !!runtime.getManifest().oauth2?.client_id,
        };
      case "drive:connect":
        await getToken(true);
        return { connected: true };
      case "drive:configure": {
        if (typeof message.enabled !== "boolean")
          throw new Error("Invalid enabled state");
        await browser.storage.local.set({
          [CONFIG]: { enabled: message.enabled },
        });
        return { enabled: (await read(CONFIG)).enabled };
      }
      case "drive:heads":
        return sync.heads();
      case "drive:run":
        return run(message.mode, message.revision);
      case "drive:backup":
        return read(BACKUP);
      default:
        throw new Error("Unknown Drive command");
    }
  }
  return {
    dispatch(what, args = {}) {
      return enqueue(() => operate({ ...args, what }));
    },
    onMessage(message, sender, reply) {
      if (
        sender.id !== runtime.id ||
        sender.url?.split("?")[0] !== runtime.getURL("drive-options.html")
      )
        return false;
      void enqueue(() => operate(message)).then(
        (result) => reply({ result }),
        (error) => reply({ error: String(error.message || error) }),
      );
      return true;
    },
  };
}
