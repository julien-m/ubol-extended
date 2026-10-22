import { expect, test } from "bun:test";
const root = new URL("../", import.meta.url);
const { createSettingsAdapter, textHash } = await import(
  new URL("packages/ublock-extension/mcp-settings.js", root).href
);
const { validateSnapshot, snapshotHash } = await import(
  new URL("packages/ublock-extension/drive-sync.js", root).href
);
const { compileFilterSelector, validateEditor } = await import(
  new URL("extensions/ublock-lite/js/mcp-selectors.js", root).href
);
const { validateHostname } = await import(
  new URL("packages/ublock-extension/mcp-adapter.js", root).href
);

const nativeBackupSource = (
  await Bun.file(
    new URL("extensions/ublock-lite/js/backup-restore.js", root),
  ).text()
)
  .replace(/^import \{[\s\S]*?\} from '[^']+';\n/gm, "")
  .replaceAll("export async function", "async function");

function setup(useNativeBackup = false) {
  const data: Record<string, any> = {
    autoReload: true,
    showBlockedCount: true,
    strictBlockMode: true,
    popupBlockMode: true,
    developerMode: true,
    enabledRulesets: ["base"],
    rulesetDetails: [{ id: "base" }, { id: "privacy" }],
    hasOmnipotence: true,
    supportsUserScripts: true,
    supportsCompiledFilters: true,
  };
  let snapshot: any = {
    filteringModes: {
      none: [],
      basic: [],
      optimal: ["all-urls"],
      complete: [],
    },
  };
  const local: Record<string, any> = {};
  const session: Record<string, any> = {};
  const storage = (store: Record<string, any>) => ({
    get: async (key: string) => ({ [key]: structuredClone(store[key]) }),
    set: async (values: any) => Object.assign(store, structuredClone(values)),
  });
  const imported: any[] = [];
  let feedback = { errors: [] as string[] };
  const calls: any[] = [];
  const request = async (r: any): Promise<any> => {
    calls.push(r);
    switch (r.what) {
      case "getOptionsPageData":
        return structuredClone(data);
      case "getDefaultConfig":
        return {
          autoReload: true,
          showBlockedCount: true,
          strictBlockMode: true,
          popupBlockMode: true,
          developerMode: false,
          rulesets: data.rulesetDetails.slice(0, 1).map((r: any) => r.id),
          filteringModes: {
            none: [],
            basic: [],
            optimal: ["all-urls"],
            complete: [],
          },
        };
      case "getImportedLists":
        return structuredClone(imported);
      case "applyRulesets":
        data.enabledRulesets = r.enabledRulesets;
        for (const id of r.toRemove ?? [])
          imported.splice(
            imported.findIndex((l) => l.id === id),
            1,
          );
        return;
      case "importFilterList":
        imported.push({ id: r.url, filters: { accepted: 1, rejected: 0 } });
        data.enabledRulesets.push(r.url);
        return;
      case "setAutoReload":
        data.autoReload = r.state;
        return;
      case "setDefaultFilteringMode":
        data.defaultLevel = r.level;
        return;
      case "getDefaultFilteringMode":
        return data.defaultLevel ?? 2;
      case "getFilteringModeDetails":
        return snapshot.filteringModes;
      case "getSandboxFilters":
        return snapshot.sandboxFilters?.join("\n") ?? "";
      case "setSandboxFilters":
        snapshot.sandboxFilters = r.text.split("\n");
        return;
      case "updateUserDnrRules":
        return feedback;
      case "getEffectiveUserRules":
        return [];
      case "setShowBlockedCount":
        data.showBlockedCount = r.state;
        return;
      case "setDeveloperMode":
        data.developerMode = r.state;
        return;
      case "setStrictBlockMode":
        data.strictBlockMode = r.state;
        return;
      case "setPopupBlockMode":
        data.popupBlockMode = r.state;
        return;
      case "setFilteringModeDetails":
        snapshot.filteringModes = structuredClone(r.modes);
        return;
      case "getAllCustomFilters":
        return snapshot.customFilters ?? [];
      case "removeAllCustomFilters":
        snapshot.customFilters = [];
        return;
      case "addManyCustomFilters":
        snapshot.customFilters = structuredClone(r.entries);
        return;
      default:
        throw new Error(`Unexpected native request ${r.what}`);
    }
  };
  const builtin = new Function(
    "addImportedLists",
    "getImportedLists",
    "removeImportedLists",
    "localRead",
    "localRemove",
    "localWrite",
    "runtime",
    "defaultSendMessage",
    nativeBackupSource + "\nreturn { backupToObject, restoreFromObject };",
  )(
    async (urls: string[]) => {
      for (const url of urls) imported.push({ id: url, enabled: true });
    },
    async () => structuredClone(imported),
    async (ids: string[]) => {
      for (let i = imported.length - 1; i >= 0; i--)
        if (ids.includes(imported[i].id)) imported.splice(i, 1);
    },
    async (key: string) => local[key],
    async (key: string) => {
      delete local[key];
    },
    async (key: string, value: any) => {
      local[key] = value;
    },
    { getManifest: () => ({ version: "1" }) },
    request,
  );
  const adapter = createSettingsAdapter({
    browser: {
      storage: { local: storage(local), session: storage(session) },
      permissions: {
        getAll: async () => ({ origins: ["<all_urls>"] }),
        contains: async () => false,
      },
      runtime: { getManifest: () => ({ name: "test", version: "1" }) },
    },
    request,
    backupToObject: useNativeBackup
      ? builtin.backupToObject
      : async () => structuredClone(snapshot),
    restoreFromObject: useNativeBackup
      ? builtin.restoreFromObject
      : async (value: any) => {
          snapshot = structuredClone(value);
        },
    validateSnapshot,
    snapshotHash,
    validateHostname,
    validateEditor,
    refreshStrict: async () => {},
    drive: { dispatch: async (what: string, args: any) => ({ what, ...args }) },
  });
  return {
    adapter,
    data,
    local,
    imported,
    calls,
    feedback: (value: string[]) => {
      feedback = { errors: value };
    },
  };
}

test("real native restore retains disabled imported lists during an unchanged MCP round trip", async () => {
  const { adapter, imported } = setup(true);
  imported.push({
    id: "https://filters.example.org/disabled.txt",
    enabled: false,
  });
  const before = await adapter.dispatch("configuration_get");
  expect(before.importedLists).toHaveLength(1);
  await adapter.dispatch("configuration_set", {
    snapshot: before.snapshot,
    expectedHash: before.hash,
  });
  expect(imported).toHaveLength(1);
  expect(
    (await adapter.dispatch("configuration_backups"))[0].importedLists,
  ).toEqual(imported);
});

test("full restore rejects invalid editor syntax before mutation and surfaces native application failures", async () => {
  const { adapter, calls, feedback } = setup(true);
  const before = await adapter.dispatch("configuration_get");
  const invalid = {
    ...before.snapshot,
    dnrRules: ["action:", "  type: invalid"],
  };
  const writes = () =>
    calls.filter((c) => c.what.startsWith("set") || c.what === "applyRulesets");
  await expect(
    adapter.dispatch("configuration_set", {
      snapshot: invalid,
      expectedHash: before.hash,
    }),
  ).rejects.toThrow("Invalid native DNR");
  expect(writes()).toHaveLength(0);
  feedback(["Browser rule limit reached"]);
  await expect(
    adapter.dispatch("configuration_set", {
      snapshot: before.snapshot,
      expectedHash: before.hash,
    }),
  ).rejects.toThrow("native application failed");
  expect(await adapter.dispatch("configuration_backups")).toHaveLength(1);
});

test("MCP dashboard changes native settings and refuses modes without site permissions", async () => {
  const { adapter, data } = setup();
  expect(
    (
      await adapter.dispatch("setting_set", {
        name: "autoReload",
        value: false,
      })
    ).value,
  ).toBe(false);
  expect((await adapter.dispatch("settings_get")).settings.autoReload).toBe(
    false,
  );
  await expect(
    adapter.dispatch("setting_set", { name: "token", value: true }),
  ).rejects.toThrow("Invalid global setting");
  data.hasOmnipotence = false;
  await expect(
    adapter.dispatch("filtering_set", {
      hostname: "news.example.org",
      level: 3,
    }),
  ).rejects.toThrow("User must grant");
  expect(
    (await adapter.dispatch("filtering_set", { level: 1 })).defaultLevel,
  ).toBe(1);
});

test("ruleset selection checks stale hash, validates IDs and preserves unrelated imported lists", async () => {
  const { adapter } = setup();
  const initial = await adapter.dispatch("rulesets_list");
  await expect(
    adapter.dispatch("rulesets_set", {
      ids: ["unknown"],
      expectedHash: initial.hash,
    }),
  ).rejects.toThrow("Unknown ruleset");
  await adapter.dispatch("rulesets_set", {
    ids: ["privacy"],
    expectedHash: initial.hash,
  });
  await expect(
    adapter.dispatch("rulesets_set", {
      ids: ["base"],
      expectedHash: initial.hash,
    }),
  ).rejects.toThrow("Configuration changed");
  await adapter.dispatch("list_import", {
    url: "https://filters.example.org/one.txt",
  });
  await adapter.dispatch("list_import", {
    url: "https://filters.example.org/two.txt",
  });
  await adapter.dispatch("list_remove", {
    url: "https://filters.example.org/one.txt",
  });
  expect((await adapter.dispatch("rulesets_list")).ids).toEqual([
    "privacy",
    "https://filters.example.org/two.txt",
  ]);
});

test("procedural cosmetic filters and native editor validation use the actual uBlock parsers", () => {
  const raw = "div:has-text(sponsored)";
  const compiled = compileFilterSelector(raw);
  expect(JSON.parse(compiled).raw).toBe(raw);
  expect(compileFilterSelector(compiled)).toBe(compiled);
  expect(
    JSON.parse(compileFilterSelector("body{display:none}")).action,
  ).toEqual(["style", "display:none"]);
  expect(() => compileFilterSelector("+js(alert)")).toThrow();
  expect(() => validateEditor("sandbox", "example.org##div[")).toThrow();
  expect(() =>
    validateEditor("sandbox", "||ads.example.org^\nexample.org##.ad"),
  ).not.toThrow();
  expect(() => validateEditor("dnr", "action:\n  type: invalid")).toThrow();
});

test("native editor reports application errors and retains backup rather than claiming success", async () => {
  const { adapter, local, feedback } = setup();
  const original = await adapter.dispatch("rules_get", { kind: "dnr" });
  const text = "action:\n  type: block\ncondition:\n  urlFilter: example.org";
  feedback(["Browser rule limit reached"]);
  await expect(
    adapter.dispatch("rules_set", {
      kind: "dnr",
      text,
      expectedHash: original.hash,
    }),
  ).rejects.toThrow("native application failed");
  expect(local.userDnrRules).toBe(text);
  expect(await adapter.dispatch("configuration_backups")).toHaveLength(1);
  await expect(
    adapter.dispatch("rules_set", {
      kind: "dnr",
      text: "",
      expectedHash: original.hash,
    }),
  ).rejects.toThrow("Configuration changed");
  expect(await textHash(local.userDnrRules)).not.toBe(original.hash);
});

test("full configuration restore normalizes native defaults and creates a recoverable backup", async () => {
  const { adapter } = setup();
  const initial = await adapter.dispatch("configuration_get");
  const target = structuredClone(initial.snapshot);
  target.customFilters = [["news.example.org", [".promo"]]];
  const result = await adapter.dispatch("configuration_set", {
    snapshot: target,
    expectedHash: initial.hash,
  });
  expect(result.snapshot.customFilters).toEqual(target.customFilters);
  expect((await adapter.dispatch("configuration_backups"))[0].hash).toBe(
    initial.hash,
  );
  await expect(
    adapter.dispatch("configuration_set", {
      snapshot: initial.snapshot,
      expectedHash: initial.hash,
    }),
  ).rejects.toThrow("Configuration changed");
  expect(
    (await adapter.dispatch("sync_configure", { enabled: true })).enabled,
  ).toBe(true);
  const exception = await adapter.dispatch("strictblock_set", {
    hostname: "news.example.org",
    scope: "permanent",
    excluded: true,
  });
  expect(exception.permanent).toContain("news.example.org");
});
