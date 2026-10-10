import { describe, expect, it } from "vitest";
import { oauthGrantOf, oauthPrincipal } from "../middleware/auth.js";
import { SIGN_IN_NAME_MAX } from "./sign-in-names.js";
import { archivedWriter, browserWriter } from "./version-writer.js";

describe("a version's writer", () => {
  it("names a browser as the sign-in listing does", () => {
    expect(
      browserWriter(
        "session-1",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ),
    ).toEqual({ kind: "browser", id: "session-1", name: "Safari on macOS" });
    expect(browserWriter("session-2", "curl/8\u0007")).toEqual({
      kind: "browser",
      id: "session-2",
      name: "A browser",
    });
  });

  it("reads the app and person back from the principal a token makes", () => {
    const principal = oauthPrincipal({
      id: "token-row",
      clientId: "client:with:colons",
      userId: "Q2xYvR8mKp4TnW6aBc0dEf1gHi3jKl5M",
      scopes: ["core.note:read"],
      expiresAtMs: null,
      createdAtMs: null,
    });
    expect(principal).not.toBeNull();
    expect(oauthGrantOf(principal!)).toEqual({
      clientId: "client:with:colons",
      authUserId: "Q2xYvR8mKp4TnW6aBc0dEf1gHi3jKl5M",
    });
    expect(oauthGrantOf({ ...principal!, source: "my-connector" })).toBeNull();
  });

  it("takes from an archive only a writer the server could have written", () => {
    expect(archivedWriter(undefined, "writer")).toEqual({ writer: null });
    expect(archivedWriter(null, "writer")).toEqual({ writer: null });
    const writer = { kind: "app", id: "record", name: "Desk laptop" };
    expect(archivedWriter(writer, "writer")).toEqual({ writer });
    for (const [value, field] of [
      ["a key", "writer"],
      [[], "writer"],
      [{ kind: "robot", id: "x", name: "x" }, "writer.kind"],
      [{ kind: "key", id: "", name: "x" }, "writer.id"],
      [
        { kind: "key", id: "x".repeat(SIGN_IN_NAME_MAX + 1), name: "x" },
        "writer.id",
      ],
      [{ kind: "key", id: "x", name: "" }, "writer.name"],
      [{ kind: "key", id: "x", name: " padded" }, "writer.name"],
      [{ kind: "key", id: "x", name: "a\nb" }, "writer.name"],
      [{ kind: "key", id: "x", name: "a\u202eb" }, "writer.name"],
      [
        { kind: "key", id: "x", name: "n".repeat(SIGN_IN_NAME_MAX + 1) },
        "writer.name",
      ],
    ] as const) {
      expect(
        archivedWriter(value, "writer"),
        JSON.stringify(value),
      ).toMatchObject({
        field,
      });
    }
  });
});
