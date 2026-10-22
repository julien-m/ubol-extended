import { applyBranding } from "./ubol-branding.ts";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const provenance = await Bun.file(
  resolve(root, "upstream/ublock-lite/provenance.json"),
).json();
const upstream = resolve(root, "upstream/ublock-lite", provenance.version);
const target = resolve(root, "extensions/ublock-lite");
const source = resolve(root, "packages/ublock-extension");
for (const [path, hash] of Object.entries(provenance.files)) {
  const bytes = await readFile(resolve(upstream, path));
  if (createHash("sha256").update(bytes).digest("hex") !== hash)
    throw new Error(`Upstream changed: ${path}`);
}
// The output is generated; source edits belong in packages/ublock-extension.
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(upstream, target, {
  recursive: true,
  filter: (path) => !path.includes("/_metadata"),
});
await applyBranding(target);
const configPath = resolve(root, "ublock.config.json");
const config = (await Bun.file(configPath).exists())
  ? await Bun.file(configPath).json()
  : {};
const manifest = JSON.parse(
  await readFile(resolve(target, "manifest.json"), "utf8"),
);
delete manifest.key;
delete manifest.update_url;
manifest.name = "uBOL Extended";
manifest.short_name = "uBOL Extended";
manifest.version_name = `${manifest.version} + Extended 1.0.0`;
manifest.permissions = [
  ...new Set([...manifest.permissions, "tabs", "identity"]),
];
manifest.background.service_worker = "/js/background.js";
manifest.key = (await Bun.file(resolve(source, "fork.json")).json()).publicKey;
if (config.googleClientId)
  manifest.oauth2 = {
    client_id: config.googleClientId,
    scopes: ["https://www.googleapis.com/auth/drive.appdata"],
  };
await writeFile(
  resolve(target, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
const patch = async (file: string, before: string, after: string) => {
  const path = resolve(target, file);
  const text = await readFile(path, "utf8");
  if (text.split(before).length !== 2)
    throw new Error(`Non-unique patch anchor: ${file}`);
  await writeFile(path, text.replace(before, after));
};
await patch(
  "js/filter-manager.js",
  "async function removeCustomFiltersByKey(",
  "export async function removeCustomFiltersByKey(",
);
// Allow native backup/restore to use the worker's internal message handler too.
await patch(
  "js/backup-restore.js",
  "    sendMessage,",
  "    sendMessage as defaultSendMessage,",
);
await patch(
  "js/backup-restore.js",
  "backupToObject(currentConfig)",
  "backupToObject(currentConfig, sendMessage = defaultSendMessage)",
);
await patch(
  "js/backup-restore.js",
  "restoreFromObject(targetConfig)",
  "restoreFromObject(targetConfig, sendMessage = defaultSendMessage, options = {})",
);
await patch(
  "js/backup-restore.js",
  "const importedListsToRemove = importedListIds.filter(a =>",
  "const importedListsToRemove = options.preserveImportedLists === true ? [] : importedListIds.filter(a =>",
);
for (const file of [
  "mcp-adapter.js",
  "mcp-native.js",
  "mcp-settings.js",
  "mcp-selectors.js",
  "mcp-bridge.js",
  "drive-sync.js",
  "drive-native.js",
]) {
  await cp(resolve(source, file), resolve(target, "js", file));
}
for (const file of [
  "mcp-options.js",
  "mcp-options.html",
  "drive-options.js",
  "drive-options.html",
]) {
  await cp(resolve(source, file), resolve(target, file));
}
await patch(
  "js/background.js",
  "import {\n    MODE_BASIC,",
  "import './mcp-bridge.js';\nimport { createNativeAdapter } from './mcp-native.js';\nimport { createDriveNative } from './drive-native.js';\n\nimport {\n    MODE_BASIC,",
);
await patch(
  "js/background.js",
  "    if ( request.what.includes(':') ) { return; }",
  "    if ( request.what?.startsWith('drive:') ) { return driveNative.onMessage(request, sender, callback); }\n    if ( request.what?.includes(':') ) { return; }",
);
await writeFile(
  resolve(target, "js/background.js"),
  (await readFile(resolve(target, "js/background.js"), "utf8")) +
    `\n// Local MCP: start only after native initialization.\nconst mcpRequest = r => onMessage(r, { origin: runtime.getURL('').slice(0, -1) });\nconst driveNative = createDriveNative({ ready: isFullyInitialized, request: mcpRequest });\nglobalThis.TmMcpNative = createNativeAdapter(isFullyInitialized, mcpRequest, driveNative);\n`,
);
await patch(
  "dashboard.html",
  'data-pane="about" data-i18n=',
  'data-pane="mcp">MCP</button><button class="tabButton" type="button" data-pane="drive">Google Drive</button><button class="tabButton" type="button" data-pane="about" data-i18n=',
);
await patch(
  "dashboard.html",
  '<section data-pane="about">',
  '<section data-pane="mcp"><iframe title="MCP" src="mcp-options.html?embedded" style="width:100%;height:520px;border:0"></iframe></section>\n<section data-pane="drive"><iframe title="Google Drive" src="drive-options.html" style="width:100%;height:650px;border:0"></iframe></section>\n<section data-pane="about">',
);
await writeFile(
  resolve(target, "css/dashboard.css"),
  (await readFile(resolve(target, "css/dashboard.css"), "utf8")) +
    '\nbody[data-pane="mcp"] > section[data-pane="mcp"],body[data-pane="drive"] > section[data-pane="drive"]{display:block}\n',
);
console.log(`Built uBOL Extended ${provenance.version}`);
