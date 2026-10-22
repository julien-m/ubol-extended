import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Brand generated UI messages without modifying the preserved upstream archive. */
export async function applyBranding(root: string) {
  const locales = resolve(root, "_locales");
  for (const locale of await readdir(locales, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue;
    const path = resolve(locales, locale.name, "messages.json");
    const messages = JSON.parse(await readFile(path, "utf8"));
    for (const entry of Object.values(messages) as { message?: string }[]) {
      if (typeof entry.message === "string") {
        entry.message = entry.message.replace(
          /uBlock Origin Lite|uBO Lite|uBOLite/g,
          "uBOL Extended",
        );
      }
    }
    await writeFile(path, JSON.stringify(messages, null, 2) + "\n");
  }
  const path = resolve(root, "dashboard.html");
  const dashboard = await readFile(path, "utf8");
  await writeFile(path, dashboard.replace('alt="uBO Lite"', 'alt="uBOL Extended"'));
}
