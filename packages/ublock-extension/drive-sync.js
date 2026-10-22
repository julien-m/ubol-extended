/* Local additions, GPL-3.0-or-later. Immutable Drive revisions avoid lost writes. */
const FORMAT = "ubol-sync-v1";
const MAX_BYTES = 1000000;
const BOOL_KEYS = [
  "autoReload",
  "developerMode",
  "popupBlockMode",
  "showBlockedCount",
  "strictBlockMode",
];
const ARRAY_KEYS = ["rulesets", "sandboxFilters", "dnrRules"];

export function validateSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid settings snapshot");
  const allowed = new Set([
    "version",
    "filteringModes",
    "customFilters",
    ...BOOL_KEYS,
    ...ARRAY_KEYS,
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unexpected settings field: ${key}`);
  for (const key of BOOL_KEYS)
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new Error(`Invalid ${key}`);
  const strings = (a) =>
    Array.isArray(a) &&
    a.length <= 20000 &&
    a.every((s) => typeof s === "string" && s.length <= 10000);
  if (value.version !== undefined && typeof value.version !== "string")
    throw new Error("Invalid version");
  for (const key of ARRAY_KEYS)
    if (value[key] !== undefined && !strings(value[key]))
      throw new Error(`Invalid ${key}`);
  const modes = value.filteringModes;
  if (
    !modes ||
    typeof modes !== "object" ||
    Array.isArray(modes) ||
    Object.keys(modes).some(
      (k) => !["none", "basic", "optimal", "complete"].includes(k),
    ) ||
    !["none", "basic", "optimal", "complete"].every((k) => strings(modes[k]))
  )
    throw new Error("Invalid filtering modes");
  if (
    value.customFilters !== undefined &&
    (!Array.isArray(value.customFilters) ||
      value.customFilters.length > 20000 ||
      value.customFilters.some(
        (e) =>
          !Array.isArray(e) ||
          e.length !== 2 ||
          typeof e[0] !== "string" ||
          !strings(e[1]),
      ))
  )
    throw new Error("Invalid custom filters");
  if (JSON.stringify(value).length > MAX_BYTES)
    throw new Error("Settings snapshot too large");
  return value;
}

export async function snapshotHash(snapshot) {
  validateSnapshot(snapshot);
  const data = structuredClone(snapshot);
  delete data.version;
  if (data.rulesets) data.rulesets.sort();
  if (data.customFilters)
    data.customFilters = data.customFilters
      .map(([h, s]) => [h, [...s].sort()])
      .sort((a, b) => a[0].localeCompare(b[0]));
  for (const values of Object.values(data.filteringModes)) values.sort();
  const stable = (value) =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, stable(value[k])]),
          )
        : value;
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stable(data))),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export function createDriveApi({ getToken, fetcher = fetch }) {
  async function request(path, options = {}) {
    const token = await getToken(false);
    const response = await fetcher(`https://www.googleapis.com${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (response.status === 401)
      throw new Error(
        "Google session expired; reconnect in Google Drive settings",
      );
    if (!response.ok)
      throw new Error(
        `Google Drive HTTP ${response.status}; reread before retrying an upload`,
      );
    return response;
  }
  return {
    async list() {
      const out = [];
      let pageToken;
      do {
        const query = new URLSearchParams({
          spaces: "appDataFolder",
          pageSize: "1000",
          q: `trashed = false and appProperties has { key='format' and value='${FORMAT}' }`,
          fields: "nextPageToken,files(id,name,description,appProperties)",
          ...(pageToken ? { pageToken } : {}),
        });
        const data = await (await request(`/drive/v3/files?${query}`)).json();
        if (!Array.isArray(data.files))
          throw new Error("Invalid Drive file listing");
        out.push(...data.files);
        if (out.length > 10000)
          throw new Error(
            "Too many sync revisions; archive maintenance required",
          );
        pageToken = data.nextPageToken;
      } while (pageToken);
      return out;
    },
    async read(id) {
      const response = await request(
        `/drive/v3/files/${encodeURIComponent(id)}?alt=media`,
      );
      const text = await response.text();
      if (text.length > MAX_BYTES + 10000)
        throw new Error("Drive revision too large");
      const doc = JSON.parse(text);
      if (
        doc.format !== FORMAT ||
        typeof doc.id !== "string" ||
        !Array.isArray(doc.parents) ||
        !doc.parents.every((p) => typeof p === "string") ||
        doc.parents.length > 100 ||
        doc.hash !== (await snapshotHash(doc.snapshot))
      )
        throw new Error("Invalid Drive revision");
      return doc;
    },
    async write(doc) {
      const boundary = `ubol_${crypto.randomUUID()}`;
      const metadata = {
        name: `${FORMAT}-${doc.id}.json`,
        parents: ["appDataFolder"],
        description: JSON.stringify({ parents: doc.parents }),
        appProperties: { format: FORMAT, revision: doc.id },
      };
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(doc)}\r\n--${boundary}--`;
      const response = await request(
        "/upload/drive/v3/files?uploadType=multipart&fields=id",
        {
          method: "POST",
          headers: {
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
        },
      );
      const result = await response.json();
      if (typeof result.id !== "string")
        throw new Error("Upload outcome unknown; reread Drive revisions");
      // Acknowledgement alone is insufficient: read the immutable content back.
      const saved = await this.read(result.id);
      if (saved.id !== doc.id || saved.hash !== doc.hash)
        throw new Error("Drive upload verification failed");
    },
  };
}

export function createSync({
  api,
  snapshot,
  restore,
  readState,
  writeState,
  backup,
}) {
  async function revisions() {
    const files = await api.list();
    const entries = files.map((file) => {
      const id = file.appProperties?.revision;
      let parents;
      try {
        parents = JSON.parse(file.description).parents;
      } catch {
        throw new Error("Invalid revision metadata");
      }
      if (
        typeof id !== "string" ||
        !Array.isArray(parents) ||
        !parents.every((p) => typeof p === "string")
      )
        throw new Error("Invalid revision metadata");
      return { fileId: file.id, id, parents };
    });
    const parents = new Set(entries.flatMap((e) => e.parents));
    const heads = entries.filter((e) => !parents.has(e.id));
    if (entries.length && !heads.length)
      throw new Error("Invalid revision graph");
    return heads;
  }
  async function readRevision(head) {
    const doc = await api.read(head.fileId);
    validateSnapshot(doc.snapshot);
    if (doc.hash !== (await snapshotHash(doc.snapshot)))
      throw new Error("Revision content hash mismatch");
    if (
      doc.id !== head.id ||
      JSON.stringify(doc.parents) !== JSON.stringify(head.parents)
    )
      throw new Error("Revision metadata mismatch");
    return doc;
  }
  async function adopt(doc, apply, expectedHash) {
    if (apply) {
      const before = validateSnapshot(await snapshot());
      if (expectedHash && (await snapshotHash(before)) !== expectedHash)
        throw new Error(
          "Sync conflict: local settings changed during synchronization",
        );
      await backup(before);
      if (
        expectedHash &&
        (await snapshotHash(await snapshot())) !== expectedHash
      )
        throw new Error("Sync conflict: local settings changed before restore");
      await restore(validateSnapshot(doc.snapshot));
      if ((await snapshotHash(await snapshot())) !== doc.hash)
        throw new Error(
          "Local restore verification failed; previous settings backup retained",
        );
    }
    await writeState({
      baseRevision: doc.id,
      baseHash: doc.hash,
      lastSync: new Date().toISOString(),
    });
    return { action: apply ? "downloaded" : "unchanged", revision: doc.id };
  }
  async function publish(heads, local) {
    const doc = {
      format: FORMAT,
      id: crypto.randomUUID(),
      parents: heads.map((h) => h.id),
      createdAt: new Date().toISOString(),
      hash: await snapshotHash(local),
      snapshot: local,
    };
    await api.write(doc);
    await writeState({
      baseRevision: doc.id,
      baseHash: doc.hash,
      lastSync: new Date().toISOString(),
    });
    const current = await revisions();
    if (current.length !== 1 || current[0].id !== doc.id)
      throw new Error(
        "Concurrent change detected; revisions retained, select a version",
      );
    return { action: "uploaded", revision: doc.id };
  }
  return {
    heads: revisions,
    async run(mode = "sync", revision) {
      const heads = await revisions();
      if (mode === "upload")
        return publish(heads, validateSnapshot(await snapshot()));
      if (mode === "download") {
        const head = revision
          ? heads.find((h) => h.id === revision)
          : heads.length === 1
            ? heads[0]
            : undefined;
        if (!head) throw new Error("Select one remote revision to restore");
        return adopt(await readRevision(head), true);
      }
      if (mode !== "sync") throw new Error("Unknown sync mode");
      if (!heads.length) return publish([], validateSnapshot(await snapshot()));
      if (heads.length !== 1)
        throw new Error(
          "Sync conflict: multiple remote versions; publish local settings or select a remote revision",
        );
      const remote = await readRevision(heads[0]);
      const local = validateSnapshot(await snapshot());
      const hash = await snapshotHash(local);
      const state = await readState();
      if (hash === remote.hash) return adopt(remote, false);
      if (!state.baseHash)
        throw new Error(
          "First connection: choose Publish this device or Restore from Drive",
        );
      if (hash === state.baseHash) return adopt(remote, true, hash);
      if (remote.hash === state.baseHash) return publish(heads, local);
      throw new Error(
        "Sync conflict: local and remote settings both changed; no overwrite performed",
      );
    },
  };
}
