/**
 * The file a `SQLITE_PATH` names, as the migration reads it, against the file
 * the driver opens for the same value.
 */
import { describe, expect, it } from "vitest";
import { fileSystemPath } from "./connection.js";

describe("fileSystemPath", () => {
  for (const [form, value, path] of [
    ["a plain path", "/data/marfa.db", "/data/marfa.db"],
    ["file: and a path", "file:/data/marfa.db", "/data/marfa.db"],
    ["file: and an empty authority", "file:///data/marfa.db", "/data/marfa.db"],
    ["file: and localhost", "file://localhost/data/marfa.db", "/data/marfa.db"],
    ["file: and a relative path", "file:data/marfa.db", "data/marfa.db"],
    ["a query", "file:/data/marfa.db?tls=0", "/data/marfa.db"],
    [
      "localhost and a query",
      "file://localhost/data/marfa.db?tls=0",
      "/data/marfa.db",
    ],
    [
      "a percent-encoded space",
      "file:/my%20data/marfa.db",
      "/my data/marfa.db",
    ],
    [
      "localhost, an encoded space and a query",
      "file://localhost/my%20data/marfa.db?tls=1",
      "/my data/marfa.db",
    ],
  ] as const) {
    it(`reads ${form}`, () => {
      expect(fileSystemPath(value)).toBe(path);
    });
  }
});
