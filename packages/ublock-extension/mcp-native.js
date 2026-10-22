import { browser } from "./ext.js";
import * as filters from "./filter-manager.js";
import { registerContentScripts } from "./scripting-manager.js";
import {
  compileSelector,
  compileFilterSelector,
  validateEditor,
} from "./mcp-selectors.js";
import { createAdapter, validateHostname } from "./mcp-adapter.js";
import { createSettingsAdapter } from "./mcp-settings.js";
import { backupToObject, restoreFromObject } from "./backup-restore.js";
import { snapshotHash, validateSnapshot } from "./drive-sync.js";
import { setStrictBlockMode } from "./ruleset-manager.js";

export function createNativeAdapter(ready, request, drive) {
  return createAdapter({
    browser,
    ready,
    compileSelector,
    compileFilterSelector,
    settings: createSettingsAdapter({
      browser,
      request,
      drive,
      backupToObject,
      restoreFromObject,
      snapshotHash,
      validateSnapshot,
      validateEditor,
      validateHostname,
      refreshStrict: (state) => setStrictBlockMode(state, true),
    }),
    native: { ...filters, registerContentScripts },
  });
}
