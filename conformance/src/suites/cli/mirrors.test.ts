import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cleanup, trackItem } from "../../utils/setup.js";
import { cliContext, unique } from "./harness.js";
import type { CliContext, ItemEnvelope } from "./harness.js";

/**
 * The two doors over a connector's copy, driven to the answers a terminal
 * can reach. A connector's copy is a row whose `source` carries the
 * `connector:` prefix, and `items.md` 45 says the one door that writes one
 * is the unpublished archive restore: `POST /keys` refuses the prefix as a
 * credential source and `POST /items` stamps the credential's own over the
 * body's. So from the terminal an item is always one's own, and promoting
 * or reconciling it is the server's refusal carried whole, each with its
 * own sentence; the promotion itself is witnessed where a copy can be
 * made, `compliance/promote-reconcile.test.ts`.
 */

let c: CliContext;

beforeAll(async () => {
  c = await cliContext("mirrors");
});

afterAll(async () => {
  await cleanup(c.ctx);
});

describe("a connector's copy from the terminal", () => {
  it("cannot be made from a key, so promote and reconcile are refused as the server refuses them", async () => {
    const refusedKey = await c.cli.refused([
      "keys",
      "create",
      "--label",
      "would-be-connector",
      "--source",
      `connector:${unique("cli-mirror")}`,
      "--type-permission",
      "core.note=write",
    ]);
    expect(refusedKey.code).toBe(1);
    expect(refusedKey.envelope.error.server?.code).toBe("validation_error");

    const own = await c.cli.json<ItemEnvelope>([
      "items",
      "create",
      "--type",
      "core.note",
      "--properties",
      JSON.stringify({ title: unique("cli-own"), body: "b" }),
    ]);
    trackItem(c.ctx, own.item.id);
    expect(own.item.source).toBe(c.ctx.source);

    const notACopy = await c.cli.refused(["items", "promote", own.item.id]);
    expect(notACopy.code).toBe(1);
    expect(notACopy.envelope.error.code).toBe("validation");
    expect(notACopy.envelope.error.server?.code).toBe("validation_error");
    expect(notACopy.envelope.error.message).toContain("already yours");

    const notPromoted = await c.cli.refused([
      "items",
      "reconcile",
      own.item.id,
    ]);
    expect(notPromoted.code).toBe(1);
    expect(notPromoted.envelope.error.server?.code).toBe("validation_error");
    expect(notPromoted.envelope.error.message).toContain(
      "nothing to reconcile",
    );

    const missing = await c.cli.refused([
      "items",
      "reconcile",
      "00000000-0000-7000-8000-000000000000",
    ]);
    expect(missing.envelope.error.code).toBe("not_found");
  });
});
