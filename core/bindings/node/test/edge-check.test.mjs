// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EdgeEnd, MarfaCore } from "../index.js";

const CONSTRAINT = { code: "validation", serverCode: "edge_constraint_violation" };

test("a move is checked as its update would be, and queues nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "marfa-node-edge-check-"));
  try {
    const core = MarfaCore.open(join(dir, "copy.sqlite"));
    /** @param {string} title */
    const note = (title) =>
      core.createItem({ type: "core.note", properties: { title } }).itemId ?? "";
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(note);
    /** @param {string} sourceId @param {string} targetId */
    const supersedes = (sourceId, targetId) => ({
      sourceId,
      targetId,
      edgeType: "supersedes",
      properties: {},
    });
    const moving = core.createEdge(supersedes(a, b)).edgeId ?? "";
    core.createEdge(supersedes(c, d));
    const queued = core.queue().length;

    assert.throws(() => core.checkEdge(supersedes(a, b)), {
      ...CONSTRAINT,
      details: { edge_type: "supersedes", source_id: a, target_id: b, constraint: "duplicate" },
    });
    assert.throws(
      () => core.checkEdgeMove(moving, { end: EdgeEnd.Target, to: d }),
      {
        ...CONSTRAINT,
        details: { edge_type: "supersedes", target_id: d, constraint: "cardinality" },
      },
      "d already has an inbound supersedes edge",
    );
    assert.throws(
      () => core.checkEdgeMove(moving, { end: EdgeEnd.Source, to: c }),
      {
        ...CONSTRAINT,
        details: { edge_type: "supersedes", source_id: c, constraint: "cardinality" },
      },
      "c already has an outbound supersedes edge",
    );
    core.checkEdgeMove(moving, { end: EdgeEnd.Target, to: b });
    core.checkEdgeMove(moving, { end: EdgeEnd.Target, to: e });
    assert.throws(
      () => core.checkEdgeMove("00000000-0000-7000-8000-000000000009", { end: EdgeEnd.Target, to: e }),
      { serverCode: "edge_not_found" },
    );
    assert.equal(core.queue().length, queued);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
