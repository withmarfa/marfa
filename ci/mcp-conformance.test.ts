/**
 * The verdict of `MCP conformance`: every check of the required scenarios
 * passes, the pinned checks still fail, and nothing else may.
 */
import { describe, expect, it } from "vitest";
import {
  type Check,
  KNOWN_FAILURES,
  problems,
  REQUIRED,
  SCENARIOS,
} from "../conformance/scripts/mcp-conformance.js";

const pass = (id: string): Check => ({ id, status: "SUCCESS" });
const fail = (id: string): Check => ({
  id,
  status: "FAILURE",
  errorMessage: "no",
});

/** A run as the server answers today. */
function today(): Record<string, Check[]> {
  return {
    ...Object.fromEntries(REQUIRED.map((s) => [s, [pass(s)]])),
    "json-schema-2020-12": [fail("json-schema-2020-12-tool-found")],
    "dns-rebinding-protection": [
      pass("localhost-host-rebinding-rejected"),
      fail("localhost-host-valid-accepted"),
    ],
  };
}

describe("MCP conformance", () => {
  it("runs the three required scenarios and the two pinned ones", () => {
    expect(REQUIRED).toEqual(["server-initialize", "ping", "tools-list"]);
    expect(Object.keys(KNOWN_FAILURES).sort()).toEqual([
      "dns-rebinding-protection",
      "json-schema-2020-12",
    ]);
    expect(SCENARIOS).toHaveLength(5);
  });

  it("passes a run where only the pinned checks fail", () => {
    expect(problems(today())).toEqual([]);
  });

  it("fails a required check that fails or warns", () => {
    const run = today();
    run.ping = [{ id: "ping", status: "WARNING" }];
    run["tools-list"] = [fail("tools-list")];
    expect(problems(run)).toEqual([
      "ping: ping ended as WARNING",
      "tools-list: tools-list ended as FAILURE: no",
    ]);
  });

  it("fails an unpinned check of a pinned scenario", () => {
    const run = today();
    run["dns-rebinding-protection"] = [
      fail("localhost-host-rebinding-rejected"),
      fail("localhost-host-valid-accepted"),
    ];
    expect(problems(run)).toEqual([
      "dns-rebinding-protection: localhost-host-rebinding-rejected ended as FAILURE: no",
    ]);
  });

  it("fails a pinned check that passes or no longer runs", () => {
    const run = today();
    run["json-schema-2020-12"] = [pass("json-schema-2020-12-tool-found")];
    run["dns-rebinding-protection"] = [
      pass("localhost-host-rebinding-rejected"),
    ];
    expect(problems(run)).toEqual([
      "json-schema-2020-12: json-schema-2020-12-tool-found is pinned as a known failure but ended as SUCCESS; remove its pin",
      "dns-rebinding-protection: localhost-host-valid-accepted is pinned as a known failure but no longer runs; remove its pin",
    ]);
  });

  it("fails a scenario that reported nothing, or nothing but information", () => {
    const run: Record<string, Check[] | undefined> = today();
    run["server-initialize"] = undefined;
    run.ping = [{ id: "ping", status: "INFO" }];
    expect(problems(run)).toEqual([
      "server-initialize: reported no result; the tool's output says why",
      "ping: reported no result; the tool's output says why",
    ]);
  });
});
