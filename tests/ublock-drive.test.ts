import { expect, test } from "bun:test";
const { createSync, createDriveApi, snapshotHash, validateSnapshot } =
  await import(
    new URL("../packages/ublock-extension/drive-sync.js", import.meta.url).href
  );
const settings = (selectors: string[] = []) => ({
  filteringModes: { none: [], basic: [], optimal: ["all-urls"], complete: [] },
  customFilters: [["example.org", selectors]],
});

function environment() {
  let local = settings();
  let state: Record<string, unknown> = {};
  const backups: unknown[] = [];
  const docs: any[] = [];
  const sync = createSync({
    api: {
      list: async () =>
        docs.map((d) => ({
          id: d.id,
          description: JSON.stringify({ parents: d.parents }),
          appProperties: { revision: d.id },
        })),
      read: async (id: string) =>
        structuredClone(docs.find((d) => d.id === id)),
      write: async (doc: any) => {
        docs.push(structuredClone(doc));
      },
    },
    snapshot: async () => structuredClone(local),
    restore: async (snapshot: any) => {
      local = structuredClone(snapshot);
    },
    readState: async () => state,
    writeState: async (value: any) => {
      state = value;
    },
    backup: async (value: unknown) => {
      backups.push(value);
    },
  });
  return {
    sync,
    docs,
    backups,
    local: () => local,
    setLocal: (value: any) => {
      local = value;
    },
  };
}

test("Drive sync round-trip persists changes, backs up before restore and refuses divergent edits", async () => {
  const env = environment();
  expect((await env.sync.run()).action).toBe("uploaded");
  env.setLocal(settings([".local"]));
  expect((await env.sync.run()).action).toBe("uploaded");
  const remote = {
    ...structuredClone(env.docs.at(-1)),
    id: crypto.randomUUID(),
    parents: [env.docs.at(-1).id],
    snapshot: settings([".remote"]),
  };
  remote.hash = await snapshotHash(remote.snapshot);
  env.docs.push(remote);
  expect((await env.sync.run()).action).toBe("downloaded");
  expect(env.backups).toHaveLength(1);
  expect(env.local()).toEqual(remote.snapshot);
  env.setLocal(settings([".different-local"]));
  const branch = {
    ...remote,
    id: crypto.randomUUID(),
    parents: [remote.id],
    snapshot: settings([".different-remote"]),
  };
  branch.hash = await snapshotHash(branch.snapshot);
  env.docs.push(branch);
  await expect(env.sync.run()).rejects.toThrow("both changed");
  expect(env.local()).toEqual(settings([".different-local"]));
});

test("concurrent Drive branches are retained; explicit publish resolves them with both parents", async () => {
  const env = environment();
  await env.sync.run();
  const first = env.docs[0];
  env.docs.push(
    { ...first, id: crypto.randomUUID(), parents: [first.id] },
    { ...first, id: crypto.randomUUID(), parents: [first.id] },
  );
  await expect(env.sync.run()).rejects.toThrow("multiple remote");
  expect((await env.sync.run("upload")).action).toBe("uploaded");
  expect(env.docs.at(-1).parents).toHaveLength(2);
});

test("sync schema rejects secrets and malformed remote data before restore", async () => {
  for (const bad of [
    { ...settings(), token: "secret" },
    { ...settings(), autoReload: "true" },
    { filteringModes: {} },
  ]) {
    expect(() => validateSnapshot(bad)).toThrow();
  }
  const env = environment();
  await env.sync.run();
  env.docs[0].snapshot = { ...settings(), token: "secret" };
  await expect(env.sync.run("download")).rejects.toThrow(
    "Unexpected settings field",
  );
  expect(env.backups).toHaveLength(0);
});

test("Drive adapter uses appdata scope paths and authenticated multipart upload with verified readback", async () => {
  const calls: { url: string; options: any }[] = [];
  const doc = {
    format: "ubol-sync-v1",
    id: crypto.randomUUID(),
    parents: [],
    snapshot: settings(),
    hash: await snapshotHash(settings()),
  };
  const api = createDriveApi({
    getToken: async () => "test-token",
    fetcher: async (url: string, options: any) => {
      calls.push({ url, options });
      return Response.json(
        url.includes("uploadType") ? { id: "test-file" } : doc,
      );
    },
  });
  await api.write(doc);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.options.headers.Authorization).toBe("Bearer test-token");
  expect(calls[0]!.options.body).toContain('"parents":["appDataFolder"]');
  expect(calls[1]!.url).toContain("test-file?alt=media");
});

test("a local edit during remote download is retained and reported as a conflict", async () => {
  let local = settings([".base"]);
  const baseHash = await snapshotHash(local);
  const remoteSnapshot = settings([".remote"]);
  const remote = {
    id: crypto.randomUUID(),
    parents: [],
    snapshot: remoteSnapshot,
    hash: await snapshotHash(remoteSnapshot),
  };
  let restored = false;
  const sync = createSync({
    api: {
      list: async () => [
        {
          id: remote.id,
          description: '{"parents":[]}',
          appProperties: { revision: remote.id },
        },
      ],
      read: async () => {
        local = settings([".edited-during-fetch"]);
        return remote;
      },
    },
    snapshot: async () => structuredClone(local),
    restore: async () => {
      restored = true;
    },
    readState: async () => ({ baseHash }),
    writeState: async () => {},
    backup: async () => {},
  });
  await expect(sync.run()).rejects.toThrow("both changed");
  expect(restored).toBe(false);
  expect(local).toEqual(settings([".edited-during-fetch"]));
});
