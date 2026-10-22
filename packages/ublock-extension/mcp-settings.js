/* Native dashboard operations, GPL-3.0-or-later. No access to MCP/OAuth secrets. */
const SETTERS = {
  autoReload: "setAutoReload",
  showBlockedCount: "setShowBlockedCount",
  strictBlockMode: "setStrictBlockMode",
  popupBlockMode: "setPopupBlockMode",
  developerMode: "setDeveloperMode",
};
const BACKUPS = "ubolMcpBackups";
export async function textHash(text) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const idsHash = (ids) => textHash(JSON.stringify([...ids].sort()));

export function createSettingsAdapter({
  browser,
  request,
  backupToObject,
  restoreFromObject,
  validateSnapshot,
  snapshotHash,
  validateHostname,
  validateEditor,
  refreshStrict,
  drive,
}) {
  const get = async () => {
    const config = await request({ what: "getOptionsPageData" });
    if (!config || !Array.isArray(config.enabledRulesets))
      throw new Error("Unable to read native configuration");
    return config;
  };
  async function normalized(snapshot) {
    validateSnapshot(snapshot);
    const defaults = await request({ what: "getDefaultConfig" });
    const out = structuredClone(snapshot);
    for (const name of Object.keys(SETTERS)) out[name] ??= defaults[name];
    for (const name of [
      "customFilters",
      "sandboxFilters",
      "dnrRules",
      "rulesets",
    ]) {
      if (!out[name]?.length) delete out[name];
    }
    return out;
  }
  async function current() {
    return normalized(await backupToObject(await get(), request));
  }
  async function guard(actual, expected) {
    if (typeof expected !== "string" || actual !== expected)
      throw new Error("Configuration changed; reread before retrying");
  }
  async function saveBackup(snapshot) {
    const old = (await browser.storage.local.get(BACKUPS))[BACKUPS] ?? [];
    const entry = {
      id: crypto.randomUUID(),
      savedAt: new Date().toISOString(),
      hash: await snapshotHash(snapshot),
      snapshot,
      importedLists: await request({ what: "getImportedLists" }),
    };
    await browser.storage.local.set({ [BACKUPS]: [...old, entry].slice(-3) });
    const saved = (await browser.storage.local.get(BACKUPS))[BACKUPS];
    if (!saved?.some((e) => e.id === entry.id))
      throw new Error(
        "Backup persistence failed; no configuration mutation performed",
      );
  }
  async function rulesets() {
    const data = await get();
    return {
      ids: data.enabledRulesets,
      hash: await idsHash(data.enabledRulesets),
      available: data.rulesetDetails,
      imported: await request({ what: "getImportedLists" }),
      maxEnabled: data.maxNumberOfEnabledRulesets,
      managed: data.adminRulesets,
    };
  }
  async function ruleText(kind) {
    if (kind === "sandbox")
      return (await request({ what: "getSandboxFilters" })) ?? "";
    if (kind === "dnr")
      return (
        (await browser.storage.local.get("userDnrRules")).userDnrRules ?? ""
      );
    throw new Error("Unknown rule editor");
  }
  async function editor(kind) {
    const text = await ruleText(kind);
    return {
      kind,
      text,
      hash: await textHash(text),
      effective: await request({ what: "getEffectiveUserRules" }),
    };
  }
  const urlOf = (value) => {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Expected an HTTP(S) list URL without credentials");
    return url.href;
  };
  return {
    async dispatch(method, args = {}) {
      switch (method) {
        case "settings_get": {
          const data = await get();
          return {
            settings: Object.fromEntries(
              Object.keys(SETTERS).map((k) => [k, data[k]]),
            ),
            capabilities: {
              hasBroadHostPermissions: data.hasOmnipotence,
              supportsUserScripts: data.supportsUserScripts,
              supportsCompiledFilters: data.supportsCompiledFilters,
              disabledFeatures: data.disabledFeatures,
            },
            permissions: await browser.permissions.getAll(),
            manifest: {
              name: browser.runtime.getManifest().name,
              version: browser.runtime.getManifest().version,
            },
          };
        }
        case "setting_set": {
          if (
            !Object.hasOwn(SETTERS, args.name) ||
            typeof args.value !== "boolean"
          )
            throw new Error("Invalid global setting");
          const before = (await get())[args.name];
          await request({ what: SETTERS[args.name], state: args.value });
          const after = (await get())[args.name];
          if (after !== args.value)
            throw new Error("Native setting verification failed");
          return {
            name: args.name,
            previous: before,
            value: after,
            persisted: true,
          };
        }
        case "filtering_get": {
          const hostname =
            args.hostname === undefined
              ? undefined
              : validateHostname(args.hostname);
          return {
            defaultLevel: await request({ what: "getDefaultFilteringMode" }),
            modes: await request({ what: "getFilteringModeDetails" }),
            ...(hostname
              ? {
                  hostname,
                  level: await request({ what: "getFilteringMode", hostname }),
                }
              : {}),
          };
        }
        case "filtering_set": {
          const hostname =
            args.hostname === undefined
              ? undefined
              : validateHostname(args.hostname);
          if (!Number.isInteger(args.level) || args.level < 0 || args.level > 3)
            throw new Error("Expected mode 0–3");
          if (args.level >= 2 && !(await get()).hasOmnipotence) {
            const allowed =
              hostname &&
              (await browser.permissions.contains({
                origins: [`*://*.${hostname}/*`],
              }));
            if (!allowed)
              throw new Error(
                "User must grant browser site permissions before enabling this mode",
              );
          }
          await request({
            what: hostname ? "setFilteringMode" : "setDefaultFilteringMode",
            hostname,
            level: args.level,
          });
          const result = await this.dispatch("filtering_get", { hostname });
          if ((hostname ? result.level : result.defaultLevel) !== args.level)
            throw new Error("Native filtering mode verification failed");
          return { ...result, persisted: true };
        }
        case "rulesets_list":
          return rulesets();
        case "rulesets_set": {
          if (
            !Array.isArray(args.ids) ||
            args.ids.some((id) => typeof id !== "string")
          )
            throw new Error("Expected ruleset IDs");
          const before = await rulesets();
          await guard(before.hash, args.expectedHash);
          const available = new Set([
            ...before.available.map((r) => r.id),
            ...before.imported.map((r) => r.id),
          ]);
          if (args.ids.some((id) => !available.has(id)))
            throw new Error("Unknown ruleset; import a URL explicitly first");
          await saveBackup(await current());
          await guard((await rulesets()).hash, args.expectedHash);
          await request({
            what: "applyRulesets",
            enabledRulesets: [...new Set(args.ids)],
          });
          const after = await rulesets();
          if (after.hash !== (await idsHash([...new Set(args.ids)])))
            throw new Error(
              "Native ruleset activation verification failed; reread rulesets_list",
            );
          return { ...after, persisted: true };
        }
        case "list_import": {
          const url = urlOf(args.url);
          const capabilities = await get();
          if (
            !capabilities.supportsCompiledFilters ||
            !capabilities.supportsUserScripts
          )
            throw new Error(
              "Enable user scripts in browser extension permissions before importing lists",
            );
          await request({ what: "importFilterList", url });
          const after = await rulesets();
          const imported = after.imported.find((l) => l.id === url);
          if (!imported || !after.ids.includes(url))
            throw new Error(
              "Imported list activation verification failed; reread rulesets_list",
            );
          return {
            list: imported,
            persisted: true,
            acceptedFilters: imported.filters?.accepted ?? 0,
            rejectedFilters: imported.filters?.rejected ?? 0,
          };
        }
        case "list_remove": {
          const url = urlOf(args.url);
          const before = await rulesets();
          if (!before.imported.some((l) => l.id === url))
            throw new Error("Unknown imported list");
          await saveBackup(await current());
          await guard((await rulesets()).hash, before.hash);
          await request({
            what: "applyRulesets",
            enabledRulesets: before.ids.filter((id) => id !== url),
            toRemove: [url],
          });
          const after = await rulesets();
          if (
            after.imported.some((l) => l.id === url) ||
            after.ids.includes(url)
          )
            throw new Error("Imported list removal verification failed");
          return { removed: url, persisted: true };
        }
        case "lists_update":
          await request({ what: "updateImportedLists" });
          return {
            imported: await request({ what: "getImportedLists" }),
            requested: true,
          };
        case "rules_get":
          return editor(args.kind);
        case "rules_set": {
          if (typeof args.text !== "string" || args.text.length > 1000000)
            throw new Error("Invalid rule text");
          const text = args.text.trim();
          const data = await get();
          if (
            text &&
            args.kind === "sandbox" &&
            (!data.supportsUserScripts || !data.supportsCompiledFilters)
          )
            throw new Error(
              "User scripts and native compilation must be available before applying filters",
            );
          if (text && args.kind === "dnr" && !data.developerMode)
            throw new Error(
              "Enable native developerMode before applying advanced DNR rules",
            );
          await validateEditor(args.kind, text);
          await guard(
            await textHash(await ruleText(args.kind)),
            args.expectedHash,
          );
          await saveBackup(await current());
          await guard(
            await textHash(await ruleText(args.kind)),
            args.expectedHash,
          );
          let feedback;
          if (args.kind === "sandbox") {
            await request({ what: "setSandboxFilters", text });
            feedback = await request({ what: "updateUserDnrRules" });
          } else {
            await browser.storage.local.set({ userDnrRules: text });
            feedback = await request({ what: "updateUserDnrRules" });
          }
          if ((await ruleText(args.kind)) !== text)
            throw new Error("Native rule text persistence failed");
          if (feedback?.errors?.length)
            throw new Error(
              `Rules saved but native application failed: ${feedback.errors.join("; ")}. Read rules_get and restore backup before retrying.`,
            );
          return {
            ...(await editor(args.kind)),
            persisted: true,
            feedback,
            browserApplicationVerified: !text || args.kind === "dnr",
            note:
              args.kind === "sandbox"
                ? "Compiled with native engine; inspect diagnostics and target page to verify cosmetic/scriptlet effects."
                : "Read effective rules and target page to verify the intended behavior.",
          };
        }
        case "configuration_get": {
          const snapshot = await current();
          return {
            snapshot,
            hash: await snapshotHash(snapshot),
            importedLists: await request({ what: "getImportedLists" }),
          };
        }
        case "configuration_set": {
          const target = await normalized(args.snapshot);
          await validateEditor(
            "sandbox",
            (target.sandboxFilters ?? []).join("\n"),
          );
          await validateEditor("dnr", (target.dnrRules ?? []).join("\n"));
          const before = await current();
          await guard(await snapshotHash(before), args.expectedHash);
          await saveBackup(before);
          await guard(await snapshotHash(await current()), args.expectedHash);
          await restoreFromObject(target, request, {
            preserveImportedLists: true,
          });
          const feedback = await request({ what: "updateUserDnrRules" });
          if (feedback?.errors?.length)
            throw new Error(
              `Configuration saved but native application failed: ${feedback.errors.join("; ")}. Previous configuration backup retained.`,
            );
          const after = await current();
          if ((await snapshotHash(after)) !== (await snapshotHash(target)))
            throw new Error(
              "Configuration restore verification failed; backup retained, reread before retry",
            );
          return {
            snapshot: after,
            hash: await snapshotHash(after),
            persisted: true,
          };
        }
        case "configuration_backups":
          return (await browser.storage.local.get(BACKUPS))[BACKUPS] ?? [];
        case "strictblock_get":
          return {
            permanent:
              (await browser.storage.local.get("excludedStrictBlockHostnames"))
                .excludedStrictBlockHostnames ?? [],
            session:
              (
                await browser.storage.session.get(
                  "excludedStrictBlockHostnames",
                )
              ).excludedStrictBlockHostnames ?? [],
          };
        case "strictblock_set": {
          const hostname = validateHostname(args.hostname);
          if (
            !["permanent", "session"].includes(args.scope) ||
            typeof args.excluded !== "boolean"
          )
            throw new Error("Invalid strict block exception");
          const store =
            args.scope === "permanent"
              ? browser.storage.local
              : browser.storage.session;
          const key = "excludedStrictBlockHostnames";
          const values = new Set((await store.get(key))[key] ?? []);
          args.excluded ? values.add(hostname) : values.delete(hostname);
          await store.set({ [key]: [...values] });
          if ((await get()).strictBlockMode) await refreshStrict(true);
          const after = await this.dispatch("strictblock_get");
          if (after[args.scope].includes(hostname) !== args.excluded)
            throw new Error(
              "Native strict block exception verification failed",
            );
          return { ...after, persisted: args.scope === "permanent" };
        }
        case "diagnostics_get":
          return {
            settings: await this.dispatch("settings_get"),
            effectiveRules: await request({ what: "getEffectiveUserRules" }),
            contentScripts: await request({
              what: "getRegisteredContentScripts",
            }),
            log: await request({ what: "getConsoleOutput" }),
          };
        case "sync_get":
          return drive.dispatch("drive:status");
        case "sync_configure":
          return drive.dispatch("drive:configure", { enabled: args.enabled });
        case "sync_run":
          return drive.dispatch("drive:run", {
            mode: args.mode,
            revision: args.revision,
          });
        default:
          throw new Error("Unknown native dashboard MCP method");
      }
    },
  };
}
