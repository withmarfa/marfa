import { describe, expect, it } from "vitest";
import { builtServer, serverCommand } from "../../../scripts/marfa-server.js";

describe("which server a boot starts", () => {
  it("starts the built server only when MARFA_SERVER_BUILT is exactly true", () => {
    expect(builtServer({ MARFA_SERVER_BUILT: "true" })).toBe(true);
    for (const value of [undefined, "", "false", "1", "TRUE"]) {
      expect(builtServer({ MARFA_SERVER_BUILT: value })).toBe(false);
    }
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
