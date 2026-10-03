import { afterEach, describe, expect, it } from "vitest";
import {
  answers,
  copyItemEvent,
  copyReplay,
  refusal,
  wireItem,
} from "../../device/marfa-answers.js";
import type { Outcome } from "../../device/protocol.js";
import {
  hydratedHarness,
  startHarness,
  scriptHydration,
  scriptWrites,
  type Harness,
} from "./harness.js";

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

const ID = "01a00000-0000-7000-8000-00000000000a";
const originalOptions = {
  id: ID,
  version: 3,
  properties: { title: "held", body: "held" },
};
const original = wireItem(originalOptions);

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

describe("a grant refusal waits for the credential", () => {
  it.each([
    { kind: "type", name: "core.note", level: "write" },
    { kind: "type", name: "core.note", level: "read" },
    { kind: "edge_type", name: "references", level: "write" },
    { kind: "extension", name: "app.notes", level: "write" },
  ])(
    "keeps an edit blocked for $kind $level until its grant returns",
    async (grant) => {
      harness = await hydratedHarness("grant-edit", {
        rows: { "core.note": [{ item: originalOptions }] },
      });
      const { device, server } = harness;
      let permitted = false;
      let current = original;
      scriptWrites(server, {
        update: [
          (request) => {
            if (!permitted)
              return refusal(403, "forbidden", "The key lacks a grant", {
                grant,
              });
            current = wireItem({
              id: ID,
              version: 4,
              properties: JSON.parse(request.body).properties,
            });
            return answers.updated(current);
          },
        ],
        read: [() => answers.updated(current)],
      });
      const write = value(
        await device.update(ID, {
          properties: { body: "kept while permission is missing" },
          version: 3,
        }),
      );
      const first = value(await device.drain());
      expect(first.verdicts[0]).toMatchObject({
        id: write.id,
        verdict: "blocked",
        reason: "credential_refused",
        refusal: { code: "forbidden", grant },
      });
      expect(first.stopped).toBeNull();
      expect(value(await device.get(ID)).properties.body).toBe(
        "kept while permission is missing",
      );
      expect(value(await device.queue())[0]?.body).toMatchObject({
        properties: { body: "kept while permission is missing" },
      });
      expect(value(await device.queue())[0]?.refusal?.grant).toEqual(grant);
      expect(value(await device.drain()).verdicts[0]?.verdict).toBe("blocked");
      permitted = true;
      expect(value(await device.drain()).verdicts[0]?.verdict).toBe("accepted");
      expect(value(await device.get(ID)).properties.body).toBe(
        "kept while permission is missing",
      );
      expect(
        server.requests.filter((request) => request.method === "PATCH"),
      ).toHaveLength(3);
      expect(
        new Set(
          server.requests
            .filter((request) => request.method === "PATCH")
            .map((request) => request.headers["idempotency-key"]),
        ),
      ).toEqual(new Set([write.idempotency_key]));
    },
  );

  it("keeps a grant-blocked create and its edit until the grant returns", async () => {
    harness = await hydratedHarness("grant-create");
    const { device, server } = harness;
    let permitted = false;
    let current: ReturnType<typeof wireItem> | undefined;
    scriptWrites(server, {
      create: [
        (request) => {
          if (!permitted)
            return refusal(
              403,
              "type_not_permitted",
              "No write access to core.note",
              {
                grant: { kind: "type", name: "core.note", level: "write" },
              },
            );
          const sent = JSON.parse(request.body);
          current = wireItem({
            id: sent.id,
            version: 1,
            properties: sent.properties,
          });
          return answers.created(current);
        },
      ],
      update: [
        (request) => {
          current = wireItem({
            id: request.pathname.split("/").at(-1) ?? "",
            version: 2,
            properties: JSON.parse(request.body).properties,
          });
          return answers.updated(current);
        },
      ],
      read: [
        () =>
          current === undefined
            ? refusal(404, "item_not_found", "No such item")
            : answers.updated(current),
      ],
    });
    const created = value(
      await device.create({
        type: "core.note",
        properties: { title: "local", body: "first" },
      }),
    );
    const id = created.item_id ?? "";
    value(
      await device.update(id, { properties: { body: "second" }, version: 0 }),
    );
    const first = value(await device.drain());
    expect(first.verdicts[0]?.verdict).toBe("blocked");
    expect(value(await device.get(id)).properties.body).toBe("second");
    expect(value(await device.queue()).map((row) => row.verdict)).toEqual([
      "blocked",
      "blocked",
    ]);
    permitted = true;
    expect(
      value(await device.drain()).verdicts.map((row) => row.verdict),
    ).toEqual(["accepted", "accepted"]);
    expect(value(await device.get(id)).properties.body).toBe("second");
  });

  it.each([4, 5])(
    "holds a later edit while an earlier receipt lacks a grant after catch-up to %s",
    async (caughtUpVersion) => {
      harness = await startHarness("grant-replay-order");
      const { device, server } = harness;
      scriptHydration(server, {
        head: "10",
        rows: { "core.note": [{ item: originalOptions }] },
      });
      const landed = wireItem({
        id: ID,
        version: 4,
        properties: { title: "held", body: "first" },
      });
      const { edges: _edges, ...eventRow } = landed;
      const caughtUp =
        caughtUpVersion === 4
          ? eventRow
          : {
              ...eventRow,
              version: 5,
              properties: { title: "held", body: "another device" },
            };
      server.copyAnswer(
        "GET",
        "/events",
        copyReplay(caughtUpVersion === 4 ? "11" : "12", [
          copyItemEvent("11", "item.updated", eventRow),
          ...(caughtUpVersion === 4
            ? []
            : [copyItemEvent("12", "item.updated", caughtUp)]),
        ]),
      );
      let current = wireItem({ ...caughtUp, id: ID });
      server.copyAnswer("GET", `/items/${ID}`, () => answers.updated(current));
      let sends = 0;
      let permitted = false;
      server.answer("PATCH", /^\/items\/[^/]+$/, (request) => {
        sends += 1;
        if (sends === 1) return answers.dropped();
        if (!permitted)
          return refusal(403, "type_not_permitted", "No write access", {
            grant: { kind: "type", name: "core.note", level: "write" },
          });
        const sent = JSON.parse(request.body);
        if (sent.properties.body === "first") {
          const answer = answers.updated(landed);
          return answer.kind === "json"
            ? { ...answer, headers: { "Idempotency-Replayed": "true" } }
            : answer;
        }
        current = wireItem({
          id: ID,
          version: caughtUpVersion + 1,
          properties: sent.properties,
        });
        return answers.updated(current);
      });
      value(await device.hydrate(["core.note"], "library"));
      const first = value(
        await device.update(ID, { properties: { body: "first" }, version: 3 }),
      );
      value(await device.drain());
      value(await device.catchUp());
      expect(value(await device.get(ID)).version).toBe(caughtUpVersion);
      const second = value(
        await device.update(ID, {
          properties: { body: "second" },
          version: caughtUpVersion,
        }),
      );
      const blocked = value(await device.drain());
      expect(blocked.verdicts.map((row) => row.id)).toEqual([first.id]);
      expect(blocked.held).toBe(1);
      const queued = value(await device.queue()).find(
        (row) => row.id === second.id,
      );
      expect(queued).toMatchObject({
        base_version: caughtUpVersion,
        reason: "awaiting_dependency",
        body: { version: caughtUpVersion },
      });
      permitted = true;
      expect(
        value(await device.drain()).verdicts.map((row) => row.verdict),
      ).toEqual(["accepted", "accepted"]);
      const sent = server.requests.filter(
        (request) => request.method === "PATCH",
      );
      expect(sent.map((request) => JSON.parse(request.body).version)).toEqual([
        3,
        3,
        3,
        caughtUpVersion === 4 ? 4 : 3,
      ]);
      expect(sent.map((request) => request.headers["idempotency-key"])).toEqual(
        [
          first.idempotency_key,
          first.idempotency_key,
          first.idempotency_key,
          second.idempotency_key,
        ],
      );
      expect(value(await device.get(ID)).properties.body).toBe("second");
    },
  );

  it.each([
    {},
    { grant: { kind: "unknown", name: "core.note", level: "write" } },
    { grant: { kind: "type", name: "core.note", level: "unknown" } },
    { grant: { kind: "type", level: "write" } },
  ])(
    "keeps a permanent fence terminal when its details are %j",
    async (details) => {
      harness = await hydratedHarness("grant-fence", {
        rows: { "core.note": [{ item: originalOptions }] },
      });
      const { device, server } = harness;
      scriptWrites(server, {
        update: [refusal(403, "forbidden", "A permanent fence", details)],
        read: [answers.updated(original)],
      });
      value(
        await device.update(ID, {
          properties: { body: "kept in queue" },
          version: 3,
        }),
      );
      expect(value(await device.drain()).verdicts[0]?.verdict).toBe("refused");
      expect(value(await device.drain()).verdicts).toEqual([]);
      expect(
        server.requests.filter((request) => request.method === "PATCH"),
      ).toHaveLength(1);
      expect(value(await device.queue())[0]?.body).toMatchObject({
        properties: { body: "kept in queue" },
      });
    },
  );
});
