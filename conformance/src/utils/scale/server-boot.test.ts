import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverProgram } from "../../../scripts/marfa-server.js";

describe("which server a boot starts", () => {
  it("starts the program MARFA_SERVER_BIN names, and refuses a missing name or one that is not a file", () => {
    const program = fileURLToPath(import.meta.url);
    expect(serverProgram({ MARFA_SERVER_BIN: program })).toBe(program);
    expect(() => serverProgram({})).toThrow(/names no server/);
    expect(() => serverProgram({ MARFA_SERVER_BIN: "" })).toThrow(
      /names no server/,
    );
    expect(() => serverProgram({ MARFA_SERVER_BIN: dirname(program) })).toThrow(
      /not a file/,
    );
  });
});
