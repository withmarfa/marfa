import { describe, expect, it } from "vitest";
import { pickLiveArtifact, pickPreviousRuns } from "./previous.js";

const run = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "completed",
  conclusion: "success",
  head_branch: "main",
  ...overrides,
});

describe("choosing last night's runs", () => {
  it("lists the completed runs on main, newest first, without this one", () => {
    const listing = {
      workflow_runs: [run(500), run(400), run(300, { conclusion: "failure" })],
    };
    expect(pickPreviousRuns(listing, "500")).toEqual([400, 300]);
  });

  it("skips a run still going and a run on another branch", () => {
    const listing = {
      workflow_runs: [
        run(500, { status: "in_progress", conclusion: null }),
        run(450, { head_branch: "ci/x" }),
        run(300),
      ],
    };
    expect(pickPreviousRuns(listing, "600")).toEqual([300]);
  });

  it("is empty when the listing is not shaped like one", () => {
    expect(pickPreviousRuns({ workflow_runs: [] }, "1")).toEqual([]);
    expect(pickPreviousRuns({}, "1")).toEqual([]);
    expect(pickPreviousRuns(null, "1")).toEqual([]);
    expect(pickPreviousRuns({ workflow_runs: [{ id: "x" }] }, "1")).toEqual([]);
  });
});

describe("choosing a run's artifact", () => {
  it("takes the first scale-figures artifact that has not expired", () => {
    const listing = {
      artifacts: [
        { id: 1, name: "marfa-scale-server-log", expired: false },
        { id: 2, name: "scale-figures", expired: true },
        { id: 3, name: "scale-figures", expired: false },
      ],
    };
    expect(pickLiveArtifact(listing)).toBe(3);
  });

  it("is null when the run kept none, or the listing is not shaped like one", () => {
    expect(pickLiveArtifact({ artifacts: [] })).toBeNull();
    expect(pickLiveArtifact({})).toBeNull();
    expect(pickLiveArtifact(null)).toBeNull();
  });
});
