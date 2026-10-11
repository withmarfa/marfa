import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "../packages/shared/src/scopes.js";

describe("the CLI owner sign-in scopes", () => {
  it("includes every permission the server offers apps", () => {
    const source = readFileSync(
      new URL("../core/marfa-cli/src/auth.rs", import.meta.url),
      "utf8",
    );
    const defaults = /const OWNER_SCOPES[^=]*= \[([\s\S]*?)\];/.exec(
      source,
    )?.[1];
    expect(defaults).toBeDefined();
    const scopes = Array.from(
      defaults!.matchAll(/"([^"]+)"/g),
      (match) => match[1]!,
    );
    expect(
      scopes
        .filter(
          (scope) =>
            !scope.includes(":") &&
            !["openid", "profile", "email", "offline_access"].includes(scope),
        )
        .sort(),
    ).toEqual([...PERMISSIONS].sort());
  });
});
