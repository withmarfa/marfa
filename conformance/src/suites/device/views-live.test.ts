import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { CliDevice, newStore } from "../../device/cli-adapter.js";
import type { Item, Outcome } from "../../device/protocol.js";
import {
  cleanup,
  createTestContext,
  trackItem,
  trackView,
} from "../../utils/setup.js";
import { requireBinary } from "./harness.js";

let client: MarfaClient;
let ctx: TestContext;
let device: CliDevice;
let view: string;
const fields = [
  "properties.probe",
  "created_at",
  "updated_at",
  "occurred_at",
] as const;
const directions = ["asc", "desc"] as const;

function value<T>(answer: Outcome<T>): T {
  expect(answer.ok, JSON.stringify(answer)).toBe(true);
  if (!answer.ok) throw new Error(answer.refusal.raw);
  return answer.value;
}

beforeAll(async () => {
  const context = await createTestContext("device", "views-sort");
  ({ client, ctx } = context);
  const values = [
    -1e30,
    -2,
    -0.125,
    false,
    0,
    true,
    1,
    1.5,
    10,
    "",
    "10",
    "2",
    "é",
    null,
    undefined,
    {},
    [],
  ];
  for (const type of ["core.note", "core.media.book"]) {
    for (const probe of values) {
      const created = await client.createItem({
        type,
        source: ctx.source,
        tags: [ctx.source],
        properties: {
          title: "Offline parity",
          body: "",
          ...(probe === undefined ? {} : { probe }),
        },
        occurred_at: "2026-03-29T01:30:00Z",
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      trackItem(ctx, created.data.item.id);
    }
  }
  const saved = await client.createView({
    title: "Sort parity",
    query: {
      types: ["core.note", "core.media.book"],
      filter: `tags contains "${ctx.source}"`,
    },
    layouts: fields.flatMap((by, index) =>
      directions.map((direction) => ({
        id: `${index}-${direction}`,
        kind: "list",
        sort: [{ by, direction }],
      })),
    ),
  });
  expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
  view = saved.data.item.id;
  trackView(ctx, view);
  device = new CliDevice({
    binary: requireBinary(),
    store: newStore("views-parity"),
    url: context.apiUrl,
    key: context.apiKey,
  });
  value(
    await device.hydrate(
      ["core.note", "core.media.book", "system.view"],
      "all",
    ),
  );
});

afterAll(async () => {
  if (device) rmSync(dirname(device.store), { recursive: true, force: true });
  if (ctx) await cleanup(ctx);
});

it("returns the same rows in the same order as the server for each shared sort", async () => {
  for (const [index, sort] of fields.entries()) {
    for (const direction of directions) {
      const remote: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listItems({
          filter: `tags contains "${ctx.source}"`,
          sort,
          direction,
          limit: 3,
          cursor,
        });
        expect(page.ok, JSON.stringify(page.error)).toBe(true);
        remote.push(...page.data.data.map((item) => item.id));
        cursor = page.data.next_cursor ?? undefined;
      } while (cursor !== undefined);
      expect(remote).toHaveLength(34);
      const local: string[] = [];
      for (let offset = 0; offset < remote.length; offset += 4) {
        const page = value(
          await device.attempt([
            "items",
            "list",
            "--view",
            view,
            "--layout",
            `${index}-${direction}`,
            "--limit",
            "4",
            "--offset",
            String(offset),
          ]),
        ) as { items: Item[] };
        local.push(...page.items.map((item) => item.id));
      }
      expect(local, `${sort} ${direction}`).toEqual(remote);
    }
  }
});
