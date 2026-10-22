import { expect, test } from "bun:test";

const root = new URL("../", import.meta.url);
const { createAdapter, validateHostname } = await import(
  new URL("packages/ublock-extension/mcp-adapter.js", root).href
);
const { compileSelector } = await import(
  new URL("extensions/ublock-lite/js/mcp-selectors.js", root).href
);

test("native parser accepts CSS but rejects declarations, scriptlets and invalid selectors before mutation", () => {
  expect(compileSelector("aside.promo")).toBe("aside.promo");
  for (const selector of [
    "",
    "div{color:red}",
    "+js(alert)",
    "div[",
    "div\nspan",
    ":has-text(hello)",
  ]) {
    expect(() => compileSelector(selector)).toThrow();
  }
  for (const host of [
    "https://example.org/",
    "*.example.org",
    "com",
    "example.org:443",
    "example.org/other",
    "a..org",
  ]) {
    expect(() => validateHostname(host)).toThrow();
  }
});

test("adapter uses native storage, deduplicates and removes exact-domain filters only", async () => {
  const values = new Map<string, string[]>([["site.example.org", [".promo"]]]);
  let registrations = 0;
  const native = {
    getAllCustomFilters: async () =>
      [...values].map(([k, v]) => [k.slice(5), [...v]]),
    addCustomFilters: async (h: string, selectors: string[]) =>
      values.set(
        `site.${h}`,
        [...new Set([...(values.get(`site.${h}`) ?? []), ...selectors])].sort(),
      ),
    removeCustomFiltersByKey: async (key: string, selectors: string[]) =>
      values.set(
        key,
        (values.get(key) ?? []).filter((s) => !selectors.includes(s)),
      ),
    registerContentScripts: async () => {
      registrations++;
    },
  };
  const adapter = createAdapter({ native, browser: {}, compileSelector });
  await adapter.dispatch("filters_add", {
    hostname: "news.example.org",
    selectors: [".promo", ".promo", "aside"],
  });
  await adapter.dispatch("filters_remove", {
    hostname: "news.example.org",
    selectors: [".promo"],
  });
  expect(values.get("site.example.org")).toEqual([".promo"]);
  expect(values.get("site.news.example.org")).toEqual(["aside"]);
  expect(registrations).toBe(2);
  const before = structuredClone(values);
  await expect(
    adapter.dispatch("filters_add", {
      hostname: "news.example.org",
      selectors: [".valid", "body{display:none}"],
    }),
  ).rejects.toThrow();
  expect(values).toEqual(before);
});

test("failed persistence is reported and stale/private tabs cannot be inspected or reloaded", async () => {
  const adapter = createAdapter({
    native: {
      getAllCustomFilters: async () => [],
      addCustomFilters: async () => {},
    },
    compileSelector,
    browser: {
      tabs: {
        get: async () => ({
          url: "https://changed.example/",
          incognito: false,
        }),
      },
    },
  });
  await expect(
    adapter.dispatch("filters_add", {
      hostname: "example.org",
      selectors: [".ad"],
    }),
  ).rejects.toThrow("verification failed");
  for (const method of ["elements_inspect", "tab_reload"]) {
    await expect(
      adapter.dispatch(method, {
        tabId: 1,
        url: "https://expected.example/",
        selector: "aside",
      }),
    ).rejects.toThrow("Tab changed");
  }
});
