import { AstFilterParser } from "./static-filtering-parser.js";
import { rulesFromText } from "./dnr-parser.js";

export function compileSelector(selector) {
  if (
    typeof selector !== "string" ||
    !selector.trim() ||
    selector.length > 4096 ||
    /[\r\n{}]/.test(selector)
  )
    throw new Error("Invalid CSS selector");
  const parser = new AstFilterParser({ nativeCssHas: true });
  parser.parse(`##${selector}`);
  if (
    parser.hasError() ||
    !parser.isCosmeticFilter() ||
    typeof parser.result.compiled !== "string" ||
    parser.result.compiled.startsWith("{")
  ) {
    throw new Error("Only plain cosmetic CSS selectors are supported");
  }
  return parser.result.compiled;
}

export function compileFilterSelector(selector) {
  if (
    typeof selector !== "string" ||
    !selector.trim() ||
    selector.length > 4096 ||
    /[\r\n]/.test(selector)
  )
    throw new Error("Invalid cosmetic selector");
  if (selector.startsWith("{")) {
    try {
      selector = JSON.parse(selector).raw;
    } catch {
      throw new Error("Invalid compiled cosmetic filter");
    }
    if (typeof selector !== "string")
      throw new Error("Compiled cosmetic filter has no raw selector");
  }
  const parser = new AstFilterParser({
    nativeCssHas: true,
    trustedSource: true,
  });
  parser.parse(`##${selector}`);
  if (
    parser.hasError() ||
    !parser.isCosmeticFilter() ||
    !parser.result.compiled
  )
    throw new Error("Invalid cosmetic filter");
  return parser.result.compiled;
}

export function validateEditor(kind, text) {
  if (kind === "dnr") {
    const parsed = rulesFromText(text);
    if (parsed.bad.length)
      throw new Error(
        `Invalid native DNR rules: ${JSON.stringify(parsed.bad)}`,
      );
    return;
  }
  if (kind !== "sandbox") throw new Error("Unknown rule editor");
  const parser = new AstFilterParser({
    nativeCssHas: true,
    trustedSource: true,
  });
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    parser.parse(line);
    if (parser.hasError())
      throw new Error(`Invalid user filter at line ${index + 1}`);
  }
}
