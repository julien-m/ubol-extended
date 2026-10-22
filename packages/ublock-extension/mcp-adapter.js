/* Local MCP additions, GPL-3.0-or-later. Native uBOL owns filter persistence. */
export function validateHostname(value) {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    !value.includes(".") ||
    !/^[a-z0-9.-]+$/.test(value) ||
    value.split(".").some((p) => !p || p.startsWith("-") || p.endsWith("-"))
  ) {
    throw new Error(
      "Expected a lowercase hostname, without URL, wildcard or port",
    );
  }
  if (new URL(`https://${value}/`).hostname !== value)
    throw new Error("Invalid hostname");
  return value;
}

export function createAdapter({
  browser,
  native,
  compileSelector,
  compileFilterSelector = compileSelector,
  settings,
  ready,
}) {
  async function checkedTab(args) {
    const tab = await browser.tabs.get(args.tabId);
    if (
      tab.incognito ||
      !/^https?:\/\//.test(tab.url || "") ||
      tab.url !== args.url
    ) {
      throw new Error("Tab changed, private or unsupported; reread tabs_list");
    }
    return tab;
  }
  async function list(hostname) {
    const entries = await native.getAllCustomFilters();
    if (!Array.isArray(entries))
      throw new Error("Unable to read native filters");
    return entries
      .filter(([hn]) => !hostname || hn === hostname)
      .map(([hostname, selectors]) => ({ hostname, selectors }));
  }
  return {
    async dispatch(method, args = {}) {
      await ready;
      switch (method) {
        case "filters_list":
          return list(
            args.hostname === undefined
              ? undefined
              : validateHostname(args.hostname),
          );
        case "filters_add":
        case "filters_remove": {
          const hostname = validateHostname(args.hostname);
          if (
            !Array.isArray(args.selectors) ||
            !args.selectors.length ||
            args.selectors.length > 100
          )
            throw new Error("Expected 1–100 selectors");
          // Compile all inputs before any mutation with the native cosmetic parser; scriptlets use the separate native rule editor.
          const selectors = [
            ...new Set(args.selectors.map(compileFilterSelector)),
          ];
          const before = (await list(hostname))[0]?.selectors ?? [];
          const expected =
            method === "filters_add"
              ? [...new Set([...before, ...selectors])].sort()
              : before.filter((s) => !selectors.includes(s)).sort();
          if (method === "filters_add")
            await native.addCustomFilters(hostname, selectors);
          else
            await native.removeCustomFiltersByKey(
              `site.${hostname}`,
              selectors,
            );
          // Native queue read is a barrier after the writes scheduled by filter-manager.
          const after = (await list(hostname))[0]?.selectors ?? [];
          if (JSON.stringify([...after].sort()) !== JSON.stringify(expected))
            throw new Error(
              "Filter persistence verification failed; reread before retry",
            );
          await native.registerContentScripts();
          return {
            hostname,
            selectors: after,
            persisted: true,
            appliesAfterReload: true,
          };
        }
        case "tabs_list":
          return (await browser.tabs.query({}))
            .filter((t) => !t.incognito && /^https?:\/\//.test(t.url || ""))
            .map(({ id, url, title }) => ({ tabId: id, url, title }));
        case "elements_inspect": {
          await checkedTab(args);
          const selector = compileSelector(args.selector);
          const result = await browser.scripting.executeScript({
            target: { tabId: args.tabId },
            func: (selector) => {
              const nodes = document.querySelectorAll(selector);
              return {
                url: location.href,
                count: nodes.length,
                elements: Array.from(nodes)
                  .slice(0, 30)
                  .map((el) => ({
                    tag: el.localName,
                    id: el.id,
                    classes: Array.from(el.classList),
                    visible:
                      !!el.getClientRects().length &&
                      getComputedStyle(el).display !== "none",
                  })),
              };
            },
            args: [selector],
          });
          if (result[0]?.result?.url !== args.url)
            throw new Error("Tab navigated during inspection");
          return result[0].result;
        }
        case "tab_reload":
          await checkedTab(args);
          await browser.tabs.reload(args.tabId);
          return { requested: true, tabId: args.tabId, loaded: false };
        default:
          if (settings) return settings.dispatch(method, args);
          throw new Error("Unknown uBlock MCP method");
      }
    },
  };
}
