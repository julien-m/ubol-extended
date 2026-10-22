import { applyBranding } from "./ubol-branding.ts";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const deadline = Date.now() + 300000;
const timeout = (limit: number) => {
  const remaining = Math.min(limit, deadline - Date.now());
  if (remaining <= 0) throw new Error("iOS build command deadline exceeded");
  return remaining;
};
const root = resolve(import.meta.dir, "..");
const source = resolve(root, "packages/ublock-ios");
const generated = resolve(root, ".claude/build/ublock-ios");
const extension = resolve(generated, "extension");
const projectRoot = resolve(generated, "ublock-local");
const project = resolve(projectRoot, "ublock-local.xcodeproj");
const chrome = resolve(root, "extensions/ublock-lite");
const provenance = await Bun.file(
  resolve(source, "safari-provenance.json"),
).json();
const configPath = resolve(root, "ublock-ios.config.json");
const config = (await Bun.file(configPath).exists())
  ? await Bun.file(configPath).json()
  : {};
const clientID = config.googleClientId ?? "";
if (
  typeof clientID !== "string" ||
  (clientID &&
    !/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientID))
) {
  throw new Error("Invalid iOS OAuth client ID");
}
const bundleID = config.bundleId ?? "org.ubol.extended";
const teamID = config.teamId ?? "";
const identity = config.signingIdentity ?? "Apple Development";
const keychainGroup = `${teamID}.${bundleID}.shared`;
const cache = resolve(root, ".claude/cache/ublock-ios");
const archive = resolve(cache, `safari-${provenance.version}.zip`);
await mkdir(cache, { recursive: true });
if (!(await Bun.file(archive).exists())) {
  const response = await fetch(provenance.url, {
    signal: AbortSignal.timeout(timeout(30000)),
  });
  if (!response.ok)
    throw new Error(`Safari archive download failed: ${response.status}`);
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
}
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== provenance.sha256
) {
  throw new Error("Safari upstream archive checksum mismatch");
}
if (!(await Bun.file(resolve(chrome, "js/drive-native.js")).exists())) {
  throw new Error("Build the Chrome fork first: bun run build:ublock");
}
await rm(extension, { recursive: true, force: true });
await mkdir(extension, { recursive: true });
execFileSync("/usr/bin/unzip", ["-q", archive, "-d", extension], {
  timeout: timeout(30000),
});
await applyBranding(extension);
const manifest = await Bun.file(resolve(extension, "manifest.json")).json();
manifest.name = "uBOL Extended";
manifest.short_name = "uBOL Extended";
manifest.version_name = `${provenance.version} + Extended 1.0.0`;
manifest.permissions = [
  ...new Set([...manifest.permissions, "nativeMessaging"]),
];
await writeFile(
  resolve(extension, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
// The official Safari archive supplies platform-specific DNR rules and API shims.
// Overlay only the shared filter/backup changes and our Drive integration.
for (const file of [
  "js/filter-manager.js",
  "js/backup-restore.js",
  "js/drive-native.js",
  "js/drive-sync.js",
  "drive-options.js",
  "drive-options.html",
]) {
  await cp(resolve(chrome, file), resolve(extension, file));
}
let background = await readFile(resolve(chrome, "js/background.js"), "utf8");
for (const line of [
  "import { createNativeAdapter } from './mcp-native.js';\n",
  "globalThis.TmMcpNative = createNativeAdapter(isFullyInitialized, mcpRequest, driveNative);\n",
]) {
  if (background.split(line).length !== 2)
    throw new Error(`MCP removal anchor missing: ${line.trim()}`);
  background = background.replace(line, "");
}
const bridgeImports = [
  "import './mcp-bridge.js';\n",
  "void import('./mcp-bridge.js');\n",
].filter((line) => background.includes(line));
if (
  bridgeImports.length !== 1 ||
  background.split(bridgeImports[0]!).length !== 2
)
  throw new Error("Expected exactly one MCP bridge import");
background = background.replace(bridgeImports[0]!, "");
await writeFile(resolve(extension, "js/background.js"), background);
const patch = async (file: string, before: string, after: string) => {
  const text = await readFile(resolve(extension, file), "utf8");
  if (text.split(before).length !== 2)
    throw new Error(`Safari patch anchor missing: ${file}`);
  await writeFile(resolve(extension, file), text.replace(before, after));
};
await patch(
  "dashboard.html",
  'data-pane="about" data-i18n=',
  'data-pane="drive">Google Drive</button><button class="tabButton" type="button" data-pane="about" data-i18n=',
);
await patch(
  "dashboard.html",
  '<section data-pane="about">',
  '<section data-pane="drive"><iframe title="Google Drive" src="drive-options.html" style="width:100%;height:650px;border:0"></iframe></section>\n<section data-pane="about">',
);
await writeFile(
  resolve(extension, "css/dashboard.css"),
  (await readFile(resolve(extension, "css/dashboard.css"), "utf8")) +
    '\nbody[data-pane="drive"] > section[data-pane="drive"]{display:block}\n',
);
await rm(projectRoot, { recursive: true, force: true });
const converter = execFileSync(
  "/usr/bin/xcrun",
  [
    "safari-web-extension-converter",
    extension,
    "--project-location",
    generated,
    "--app-name",
    "ublock-local",
    "--bundle-identifier",
    bundleID,
    "--swift",
    "--ios-only",
    "--no-open",
    "--no-prompt",
  ],
  { encoding: "utf8", timeout: 30000 },
);
console.log(converter.trim());
const pbxPath = resolve(project, "project.pbxproj");
const pbx = JSON.parse(
  execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", pbxPath], {
    encoding: "utf8",
  }),
);
type PbxObject = Record<string, any>;
const objects = pbx.objects as Record<string, PbxObject>;
const allObjects = () => Object.entries(objects);
const id = () => randomBytes(12).toString("hex").toUpperCase();
const appGroup = allObjects().find(
  ([, o]) => o.isa === "PBXGroup" && o.path === "ublock-local",
)?.[1];
const extGroup = allObjects().find(
  ([, o]) => o.isa === "PBXGroup" && o.path === "ublock-local Extension",
)?.[1];
const appTarget = allObjects().find(
  ([, o]) =>
    o.isa === "PBXNativeTarget" &&
    o.productType === "com.apple.product-type.application",
)?.[1];
const extTarget = allObjects().find(
  ([, o]) =>
    o.isa === "PBXNativeTarget" &&
    o.productType === "com.apple.product-type.app-extension",
)?.[1];
if (!appGroup || !extGroup || !appTarget || !extTarget)
  throw new Error("Unexpected Safari converter project structure");
const sourcePhase = (target: PbxObject) =>
  objects[
    target.buildPhases.find(
      (key: string) => objects[key]?.isa === "PBXSourcesBuildPhase",
    )
  ];
const addSource = (name: string, group: PbxObject, target: PbxObject) => {
  const fileRef = id(),
    buildFile = id();
  objects[fileRef] = {
    isa: "PBXFileReference",
    lastKnownFileType: "sourcecode.swift",
    path: name,
    sourceTree: "<group>",
  };
  objects[buildFile] = { isa: "PBXBuildFile", fileRef };
  group.children.push(fileRef);
  sourcePhase(target)!.files.push(buildFile);
};
const removeFiles = new Set([
  "AppDelegate.swift",
  "SceneDelegate.swift",
  "ViewController.swift",
  "SafariWebExtensionHandler.swift",
]);
const removedReferences = new Set(
  allObjects()
    .filter(([, o]) => o.isa === "PBXFileReference" && removeFiles.has(o.path))
    .map(([key]) => key),
);
const removedBuildFiles = new Set(
  allObjects()
    .filter(
      ([, o]) => o.isa === "PBXBuildFile" && removedReferences.has(o.fileRef),
    )
    .map(([key]) => key),
);
for (const [, o] of allObjects()) {
  if (Array.isArray(o.children))
    o.children = o.children.filter(
      (key: string) => !removedReferences.has(key),
    );
  if (Array.isArray(o.files))
    o.files = o.files.filter((key: string) => !removedBuildFiles.has(key));
}
for (const key of [...removedReferences, ...removedBuildFiles])
  delete objects[key];
for (const [target, group, folder, names] of [
  [
    appTarget,
    appGroup,
    "ublock-local",
    ["app.swift", "oauth-store.swift", "oauth-flow.swift"],
  ],
  [
    extTarget,
    extGroup,
    "ublock-local Extension",
    ["safari-handler.swift", "oauth-store.swift"],
  ],
] as const) {
  for (const name of names) {
    await cp(resolve(source, name), resolve(projectRoot, folder, name));
    addSource(name, group, target);
  }
  const entitlements = { "keychain-access-groups": [keychainGroup] };
  await writeFile(
    resolve(projectRoot, folder, "shared.entitlements"),
    plist(entitlements),
  );
  const configurations =
    objects[target.buildConfigurationList]!.buildConfigurations;
  for (const configuration of configurations) {
    const settings = objects[configuration]!.buildSettings;
    settings.PRODUCT_BUNDLE_IDENTIFIER =
      folder === "ublock-local" ? bundleID : `${bundleID}.Extension`;
    settings.IPHONEOS_DEPLOYMENT_TARGET = "18.6";
    settings.DEVELOPMENT_TEAM = teamID;
    settings.CODE_SIGN_IDENTITY = identity;
    settings.CODE_SIGN_ENTITLEMENTS = `${folder}/shared.entitlements`;
    settings.SWIFT_VERSION = "5.0";
    settings.INFOPLIST_KEY_CFBundleDisplayName = "uBOL Extended";
    settings.INFOPLIST_KEY_CFBundleName = "uBOL Extended";
    // Shared Keychain actor is deliberately not implicitly MainActor-isolated.
    delete settings.SWIFT_DEFAULT_ACTOR_ISOLATION;
    delete settings.INFOPLIST_KEY_UIMainStoryboardFile;
    delete settings.INFOPLIST_KEY_UILaunchStoryboardName;
  }
  const infoPath = resolve(projectRoot, folder, "Info.plist");
  const info =
    folder === "ublock-local"
      ? {
          UILaunchScreen: {},
          UIApplicationSceneManifest: {
            UIApplicationSupportsMultipleScenes: false,
          },
        }
      : JSON.parse(
          execFileSync(
            "/usr/bin/plutil",
            ["-convert", "json", "-o", "-", infoPath],
            { encoding: "utf8" },
          ),
        );
  info.CFBundleDisplayName = "uBOL Extended";
  info.UbolGoogleClientID = clientID;
  info.UbolKeychainAccessGroup = keychainGroup;
  if (folder === "ublock-local" && clientID) {
    info.CFBundleURLTypes = [
      {
        CFBundleURLName: "Google OAuth",
        CFBundleURLSchemes: [
          `com.googleusercontent.apps.${clientID.replace(/\.apps\.googleusercontent\.com$/, "")}`,
        ],
      },
    ];
  }
  await writeFile(infoPath, plist(info));
}
for (const [, o] of allObjects()) {
  if (
    o.isa === "XCBuildConfiguration" &&
    o.buildSettings?.IPHONEOS_DEPLOYMENT_TARGET
  )
    o.buildSettings.IPHONEOS_DEPLOYMENT_TARGET = "18.6";
}
await writeFile(pbxPath, JSON.stringify(pbx));
execFileSync("/usr/bin/plutil", ["-convert", "xml1", pbxPath]);
for (const name of [
  "AppDelegate.swift",
  "SceneDelegate.swift",
  "ViewController.swift",
])
  await rm(resolve(projectRoot, "ublock-local", name));
await rm(
  resolve(
    projectRoot,
    "ublock-local Extension/SafariWebExtensionHandler.swift",
  ),
);
await writeFile(
  resolve(generated, "build-receipt.json"),
  JSON.stringify(
    {
      upstream: provenance,
      project,
      bundleID,
      teamID,
      oauthConfigured: !!clientID,
      compiled: false,
      installedOnIPhone: false,
      safariRuntimeVerified: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Safari/iOS project: ${project}`);
console.log(
  clientID
    ? "iOS OAuth client configured"
    : "iOS OAuth client not configured; login stays disabled",
);
if (process.argv.includes("--build")) {
  const identities = execFileSync(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    { encoding: "utf8" },
  );
  if (!identities.includes(identity))
    throw new Error("Required signing identity unavailable");
  const log = resolve(generated, "xcode-build.log");
  try {
    const output = execFileSync(
      "/usr/bin/xcodebuild",
      [
        "-project",
        project,
        "-scheme",
        "ublock-local",
        "-configuration",
        "Debug",
        "-sdk",
        "iphonesimulator",
        "-destination",
        "generic/platform=iOS Simulator",
        "-derivedDataPath",
        resolve(generated, "derived-data"),
        `CODE_SIGN_IDENTITY=${identity}`,
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGNING_REQUIRED=YES",
        "ARCHS=arm64",
        "ONLY_ACTIVE_ARCH=YES",
        "build",
      ],
      {
        encoding: "utf8",
        timeout: timeout(300000),
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    await writeFile(log, output);
    // Xcode forces an ad-hoc signature for simulator products even when an identity
    // is supplied. Replace it explicitly and verify before recording a signed build.
    const app = resolve(
      generated,
      "derived-data/Build/Products/Debug-iphonesimulator/ublock-local.app",
    );
    const appex = resolve(app, "PlugIns/ublock-local Extension.appex");
    for (const [bundle, folder] of [
      [appex, "ublock-local Extension"],
      [app, "ublock-local"],
    ]) {
      execFileSync(
        "/usr/bin/codesign",
        [
          "--force",
          "--sign",
          identity,
          "--timestamp=none",
          "--entitlements",
          resolve(projectRoot, folder!, "shared.entitlements"),
          bundle!,
        ],
        { timeout: timeout(20000), stdio: ["ignore", "pipe", "pipe"] },
      );
    }
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
      timeout: timeout(10000),
      stdio: ["ignore", "pipe", "pipe"],
    });
    execFileSync("/usr/bin/codesign", ["-dv", "--verbose=4", app], {
      encoding: "utf8",
      timeout: timeout(10000),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const receipt = await Bun.file(
      resolve(generated, "build-receipt.json"),
    ).json();
    receipt.compiled = true;
    receipt.signingIdentity = identity;
    receipt.signatureVerified = true;
    receipt.app = app;
    await writeFile(
      resolve(generated, "build-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    console.log(
      "iOS Simulator build completed; no device installation or Safari runtime claimed.",
    );
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string };
    await writeFile(
      log,
      String(result.stdout ?? "") + String(result.stderr ?? ""),
    );
    throw new Error(`Xcode build failed; inspect ${log}`);
  }
}
function plist(value: unknown): string {
  const encode = (item: any): string => {
    if (typeof item === "string")
      return `<string>${item.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`;
    if (typeof item === "boolean") return item ? "<true/>" : "<false/>";
    if (Array.isArray(item))
      return `<array>${item.map(encode).join("")}</array>`;
    return `<dict>${Object.entries(item)
      .map(([key, entry]) => `<key>${key}</key>${encode(entry)}`)
      .join("")}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">${encode(value)}</plist>\n`;
}
