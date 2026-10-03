import { afterEach, expect, it } from "vitest";
import {
  answers,
  edgeEvent,
  copyReplay,
  refusal,
  wireEdge,
  writeAnswers,
} from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import { startHarness, scriptHydration, type Harness } from "./harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});
const SOURCE = "01a00000-0000-7000-8000-00000000000a";
const TARGET = "01a00000-0000-7000-8000-00000000000b";
const EDGE = "01a00000-0000-7000-8000-0000000000e1";
function value<T>(result: Outcome<T>): T {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.refusal.raw);
  return result.value;
}

it.each([
  { grantBlocked: false, caughtUpVersion: 2 },
  { grantBlocked: true, caughtUpVersion: 2 },
  { grantBlocked: false, caughtUpVersion: 3 },
  { grantBlocked: true, caughtUpVersion: 3 },
])(
  "keeps an edge receipt safe with grant blocked $grantBlocked and catch-up version $caughtUpVersion",
  async ({ grantBlocked, caughtUpVersion }) => {
    harness = await startHarness("edge-replay-read");
    const { device, server } = harness;
    const edge = (version: number, weight: number) => ({
      id: EDGE,
      source_id: SOURCE,
      target_id: TARGET,
      edge_type: "references",
      version,
      properties: { weight },
    });
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: SOURCE,
              properties: { title: "source", body: "source" },
              edges: {
                references: { data: [wireEdge(edge(1, 1))], next_cursor: null },
              },
            },
          },
          {
            item: {
              id: TARGET,
              properties: { title: "target", body: "target" },
            },
          },
        ],
      },
    });
    server.copyAnswer(
      "GET",
      "/events",
      copyReplay(caughtUpVersion === 2 ? "11" : "12", [
        edgeEvent("11", "edge.updated", wireEdge(edge(2, 2))),
        ...(caughtUpVersion === 2
          ? []
          : [edgeEvent("12", "edge.updated", wireEdge(edge(3, 9)))]),
      ]),
    );
    let sends = 0;
    let current = edge(caughtUpVersion, caughtUpVersion === 2 ? 2 : 9);
    server.copyAnswer("GET", `/edges/${EDGE}`, () =>
      writeAnswers.edge(current, 200),
    );
    let permitted = !grantBlocked;
    server.answer("PATCH", /^\/edges\/[^/]+$/, (request) => {
      sends += 1;
      if (sends === 1) return answers.dropped();
      if (!permitted)
        return refusal(403, "edge_type_not_permitted", "No edge write access", {
          grant: { kind: "edge_type", name: "references", level: "write" },
        });
      const sent = JSON.parse(request.body);
      if (sent.properties.weight === 2) {
        const answer = writeAnswers.edge(edge(2, 2), 200);
        return answer.kind === "json"
          ? { ...answer, headers: { "Idempotency-Replayed": "true" } }
          : answer;
      }
      if (sent.version !== current.version) {
        return answers.edgeVersionConflict(wireEdge(current));
      }
      current = edge(current.version + 1, 3);
      return writeAnswers.edge(current, 200);
    });
    value(await device.hydrate(["core.note"], "library"));
    const first = value(
      await device.updateEdge(EDGE, { properties: { weight: 2 }, version: 1 }),
    );
    value(await device.drain());
    value(await device.catchUp());
    const second = value(
      await device.updateEdge(EDGE, {
        properties: { weight: 3 },
        version: caughtUpVersion,
      }),
    );
    if (grantBlocked) {
      const blocked = value(await device.drain());
      expect(blocked.verdicts.map((row) => row.verdict)).toEqual(["blocked"]);
      expect(blocked.held).toBe(1);
      permitted = true;
    }
    expect(
      value(await device.drain()).verdicts.map((row) => row.verdict),
    ).toEqual(["accepted", caughtUpVersion === 2 ? "accepted" : "blocked"]);
    const sent = server.requests.filter(
      (request) => request.method === "PATCH",
    );
    expect(JSON.parse(sent.at(-1)?.body ?? "{}").version).toBe(
      caughtUpVersion === 2 ? 2 : 1,
    );
    expect(sent.at(-1)?.headers["idempotency-key"]).toBe(
      second.idempotency_key,
    );
    expect(
      new Set(
        sent.slice(0, -1).map((request) => request.headers["idempotency-key"]),
      ),
    ).toEqual(new Set([first.idempotency_key]));
  },
);
