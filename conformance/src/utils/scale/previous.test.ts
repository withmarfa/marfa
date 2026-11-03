import { describe, expect, it } from "vitest";
import { pickPreviousArtifact } from "./previous.js";

const artifact = (
  id: number,
  run: number,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name: "scale-figures",
  expired: false,
  created_at: `2026-11-0${id}T05:00:00Z`,
  workflow_run: { id: run, head_branch: "main" },
  ...overrides,
});

describe("choosing last night's artifact", () => {
  it("takes the newest unexpired one from main that is not this run's", () => {
    const list = {
      artifacts: [artifact(5, 500), artifact(4, 400), artifact(3, 300)],
    };
    expect(pickPreviousArtifact(list, "500")?.workflow_run.id).toBe(400);
  });

  it("skips an expired artifact and one from another branch", () => {
    const list = {
      artifacts: [
        artifact(5, 500, { workflow_run: { id: 500, head_branch: "ci/x" } }),
        artifact(4, 400, { expired: true }),
        artifact(3, 300),
      ],
    };
    expect(pickPreviousArtifact(list, "600")?.workflow_run.id).toBe(300);
  });

  it("is null when there is none, or the list is not shaped like one", () => {
    expect(pickPreviousArtifact({ artifacts: [] }, "1")).toBeNull();
    expect(pickPreviousArtifact({}, "1")).toBeNull();
    expect(pickPreviousArtifact(null, "1")).toBeNull();
    expect(
      pickPreviousArtifact({ artifacts: [artifact(1, 1)] }, "1"),
    ).toBeNull();
  });

  it("ignores an entry with no run", () => {
    expect(
      pickPreviousArtifact({ artifacts: [{ id: 1, expired: false }] }, "9"),
    ).toBeNull();
  });
});
