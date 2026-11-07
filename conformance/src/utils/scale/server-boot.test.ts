import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  builtServer,
  serverCommand,
  serverProgram,
} from "../../../scripts/marfa-server.js";

describe("which server a boot starts", () => {
  it("starts the built server only when MARFA_SERVER_BUILT is exactly true", () => {
    expect(builtServer({ MARFA_SERVER_BUILT: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      expect(builtServer({ MARFA_SERVER_BUILT: value })).toBe(false);
    }
  });

  it("starts the program MARFA_SERVER_BIN names, and refuses one that is not a file or beside MARFA_SERVER_BUILT", () => {
    const program = fileURLToPath(import.meta.url);
    expect(serverProgram({})).toBeUndefined();
    expect(serverProgram({ MARFA_SERVER_BIN: "" })).toBeUndefined();
    expect(serverProgram({ MARFA_SERVER_BIN: program })).toBe(program);
    expect(() => serverProgram({ MARFA_SERVER_BIN: dirname(program) })).toThrow(
      /not a file/,
    );
    expect(() =>
      serverProgram({ MARFA_SERVER_BIN: program, MARFA_SERVER_BUILT: "true" }),
    ).toThrow(/set one/);
  });

  it("starts the sources through tsx unless asked for the build", () => {
    const command = serverCommand(false);
    expect(command).toContain("tsx");
    expect(command.at(-1)).toBe("src/index.ts");
    expect(command.join(" ")).not.toContain("dist");
  });

  it("starts the build's own entry and preload, or says to build", () => {
    let command: string[] | undefined;
    try {
      command = serverCommand(true);
    } catch (error) {
      expect(String(error)).toMatch(/build the server first/);
      return;
    }
    expect(command.at(-1)).toMatch(/packages\/server\/dist\/index\.js$/);
    expect(command.join(" ")).toMatch(/--import \S*dist\/instrumentation\.js/);
    expect(command.join(" ")).not.toContain("tsx");
  });
});
