import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Integration: the same Swift OAuth core compiled into the iOS app runs natively.
// No Google credentials or simulator are needed. Compiler + execution <= 10 s.
test("iOS OAuth uses PKCE and rejects foreign, stale and ambiguous callbacks", async () => {
  const work = await mkdtemp(resolve(tmpdir(), "ubol-oauth-test-"));
  const deadline = Date.now() + 9000;
  const timeout = () => Math.max(1, deadline - Date.now());
  try {
    const main = resolve(work, "main.swift");
    await writeFile(
      main,
      `
import Foundation
let state = CommandLine.arguments[1]
let code = CommandLine.arguments[2]
let redirect = URL(string: CommandLine.arguments[3])!
let verifier = try OAuthFlow.nonce()
let auth = try OAuthFlow.authorizationURL(clientID: CommandLine.arguments[4], redirect: redirect.absoluteString, verifier: verifier, state: state)
func callback(_ base: URL, _ items: [URLQueryItem]) -> URL {
    var value = URLComponents(url: base, resolvingAgainstBaseURL: false)!
    value.queryItems = items
    return value.url!
}
let fields = [URLQueryItem(name: "state", value: state), URLQueryItem(name: "code", value: code)]
let valid = try OAuthFlow.authorizationCode(callback: callback(redirect, fields), redirect: redirect, state: state)
let invalid = [
    callback(redirect, [URLQueryItem(name: "state", value: state + "changed"), fields[1]]),
    callback(URL(string: "https://untrusted.invalid/oauthredirect")!, fields),
    callback(URL(string: redirect.absoluteString + "extra")!, fields),
    callback(redirect, fields + [fields[0]]),
    callback(redirect, fields + [fields[1]]),
    callback(redirect, fields + [URLQueryItem(name: "error", value: "access_denied")]),
]
let rejected = invalid.map { candidate in
    do { _ = try OAuthFlow.authorizationCode(callback: candidate, redirect: redirect, state: state); return false }
    catch { return true }
}
let output: [String: Any] = ["valid": valid, "rejected": rejected, "verifier": verifier, "auth": auth.absoluteString]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: output))
`,
    );
    const binary = resolve(work, "oauth-flow-test");
    execFileSync(
      "/usr/bin/xcrun",
      [
        "swiftc",
        new URL("../packages/ublock-ios/oauth-flow.swift", import.meta.url)
          .pathname,
        main,
        "-o",
        binary,
      ],
      { timeout: timeout(), stdio: ["ignore", "pipe", "pipe"] },
    );
    const state = randomUUID(),
      code = randomUUID();
    const redirect = `com.example.${randomUUID().toLowerCase()}:/oauthredirect`;
    const clientID = `${randomUUID()}.apps.googleusercontent.com`;
    const result = JSON.parse(
      execFileSync(binary, [state, code, redirect, clientID], {
        timeout: timeout(),
        encoding: "utf8",
      }),
    );
    expect(result.valid).toBe(code);
    expect(result.rejected.every((value: boolean) => value)).toBe(true);
    const auth = new URL(result.auth);
    expect(auth.searchParams.get("state")).toBe(state);
    expect(auth.searchParams.get("redirect_uri")).toBe(redirect);
    expect(auth.searchParams.get("client_id")).toBe(clientID);
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(result.verifier).digest("base64url"),
    );
    expect(result.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}, 10000);
