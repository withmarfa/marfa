import { describe, expect, it } from "vitest";
import { localFilePathFor } from "./paths.js";
import { toLibsqlUrl } from "./open.js";

describe("which store paths name a file on this machine", () => {
  it("gives a plain path back unchanged", () => {
    expect(localFilePathFor("/var/data/store.db")).toBe("/var/data/store.db");
    expect(localFilePathFor("./data/store.db")).toBe("./data/store.db");
  });

  it("has no file for memory, in either spelling", () => {
    expect(localFilePathFor(":memory:")).toBeUndefined();
    // `toLibsqlUrl` expands `:memory:` to this, so it can arrive already
    // expanded. Read as a file it would name a path called `:memory:`.
    expect(localFilePathFor("file::memory:?cache=shared")).toBeUndefined();
  });

  it("has no file for a remote database", () => {
    expect(localFilePathFor("libsql://db.example/x")).toBeUndefined();
    expect(localFilePathFor("https://db.example/x")).toBeUndefined();
    expect(localFilePathFor("http://db.example/x")).toBeUndefined();
  });

  it("strips the scheme and the query from a file URL", () => {
    expect(localFilePathFor("file:/a/b/store.db")).toBe("/a/b/store.db");
    expect(localFilePathFor("file:./data/store.db?mode=rwc")).toBe(
      "./data/store.db",
    );
  });

  it("does not mistake a relative path for a remote one", () => {
    // The bug this replaced: one caller tested `startsWith("http")` with no
    // `//`, so a directory named `httpd` was remote to it and local to the
    // lock beside it. Neither answer was visibly wrong on its own.
    expect(localFilePathFor("httpd/store.db")).toBe("httpd/store.db");
    expect(localFilePathFor("libsqlite/store.db")).toBe("libsqlite/store.db");
  });

  it("agrees with the URL the database is actually opened on", () => {
    // The two used to decide remoteness separately, so the property worth
    // pinning is that nothing is remote to the connection and local to the
    // lock — a lock contending over a file nobody writes.
    //
    // The expectation is written out rather than recomputed from the same
    // expression the implementation uses. Sharing the regex would make this
    // agree with itself: both sides wrong the same way still passes.
    const expected: ReadonlyArray<readonly [string, boolean]> = [
      ["/var/data/store.db", false],
      ["./data/store.db", false],
      ["file:/a/b/store.db", false],
      ["httpd/store.db", false],
      ["libsqlite/store.db", false],
      [":memory:", true],
      ["file::memory:?cache=shared", true],
      ["libsql://db.example/x", true],
      ["https://db.example/x", true],
      ["http://db.example/x", true],
    ];

    for (const [path, remote] of expected) {
      const url = toLibsqlUrl(path);
      // A store the connection opens over the network, or holds only in
      // memory, is one the lock must not make a file for.
      const connectionKeepsNoFile =
        url.startsWith("libsql://") ||
        url.startsWith("http://") ||
        url.startsWith("https://") ||
        url.includes(":memory:");

      expect({ path, lock: localFilePathFor(path) === undefined }).toEqual({
        path,
        lock: remote,
      });
      expect({ path, connection: connectionKeepsNoFile }).toEqual({
        path,
        connection: remote,
      });
    }
  });
});
