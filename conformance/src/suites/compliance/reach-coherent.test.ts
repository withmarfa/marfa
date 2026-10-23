import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { MarfaItem } from "../../client/types.js";
import {
  bootFreshServer,
  FRESH_SERVER_TIMEOUT_MS,
  type FreshServer,
} from "../../utils/fresh-server.js";
import { tapStream } from "../../utils/stream-tap.js";

/**
 * A conditional read answers from one moment: a write that changes the read
 * reach while the read waits is either wholly before the answer or wholly
 * after it, and the certificate on the answer says which
 * (`reach/conditional-coherent`).
 *
 * The fixture holds a conditional read inside its snapshot, after the read
 * reach has been judged and before the door reads (`hold:read-snapshot`), lands
 * writes that retype an item and tag it, and lets the read go. The answer
 * may be `409`; an answer of `200` must show the item as one state or the
 * other, whichever its certificate names, and never as a mixture.
 */

let server: FreshServer;
let working: MarfaClient;

beforeAll(async () => {
  server = await bootFreshServer("reach-coherent");
  working = new MarfaClient({
    baseUrl: server.apiUrl,
    apiKey: server.workingKey,
  });
}, FRESH_SERVER_TIMEOUT_MS);

afterAll(async () => {
  await server.stop();
}, FRESH_SERVER_TIMEOUT_MS);

async function reach(): Promise<string> {
  const tap = await tapStream(server.apiUrl, server.workingKey, {
    query: [
      ["edges", "all"],
      ["copy", "1"],
    ],
  });
  try {
    const events = await tap.until(
      (seen) => seen.some((event) => event.event === "stream_live"),
      "the copy stream live",
    );
    return (
      events.find((event) => event.event === "stream_live")!.data as {
        reach: string;
      }
    ).reach;
  } finally {
    await tap.close();
  }
}

interface Page {
  data: Array<{
    item: MarfaItem;
    metadata: { item_id: string; tags?: string[] };
  }>;
}

function conditionalList(reachHeader: string, tag: string): Promise<Response> {
  return fetch(
    `${server.apiUrl}/items?include=metadata&tags=${tag}&limit=100`,
    {
      headers: {
        Authorization: `Bearer ${server.workingKey}`,
        "X-Marfa-Reach": reachHeader,
      },
    },
  );
}

describe("a conditional read while a write that changes the reach lands", () => {
  it("answers 409, or an answer that is wholly before the write or wholly after it", async () => {
    const tag = "coherence";
    const made = await working.createItem({
      type: "core.note",
      properties: { body: "before the write" },
      tags: [tag],
    });
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const item = made.data.item;
    const sibling = await working.createItem({
      type: "core.note",
      properties: { body: "untouched" },
      tags: [tag],
    });
    expect(sibling.ok).toBe(true);
    const before = await reach();

    await server.setFault("hold:read-snapshot");
    const reading = conditionalList(before, tag);
    await server.waitForHold("hold:read-snapshot");

    const moved = await working.updateItem(item.id, {
      version: item.version,
      type: "core.bookmark",
      retype: true,
      properties: { url: "https://example.com/after" },
    });
    expect(moved.ok, JSON.stringify(moved.error)).toBe(true);
    const tagged = await working.addTags(item.id, ["after"]);
    expect(tagged.ok, JSON.stringify(tagged.error)).toBe(true);
    const after = await reach();
    // The witness: the write did change the reach.
    expect(after).not.toBe(before);

    await server.clearFault("hold:read-snapshot");
    const answer = await reading;
    if (answer.status === 409) {
      expect(answer.headers.get("X-Marfa-Reach")).toBeNull();
      return;
    }
    expect(answer.status).toBe(200);
    const certificate = answer.headers.get("X-Marfa-Reach");
    const page = (await answer.json()) as Page;
    const row = page.data.find((candidate) => candidate.item.id === item.id);
    expect(
      row,
      `the retyped item is missing from the answer ${JSON.stringify(page)}`,
    ).toBeDefined();
    const tags = row!.metadata.tags ?? [];
    const state = { type: row!.item.type, after: tags.includes("after") };
    if (certificate === before)
      expect(state, "an answer certified before the write shows it").toEqual({
        type: "core.note",
        after: false,
      });
    else if (certificate === after)
      expect(state, "an answer certified after the write omits it").toEqual({
        type: "core.bookmark",
        after: true,
      });
    else
      throw new Error(
        `the answer carries an unknown certificate ${String(certificate)}`,
      );
    expect(page.data.map((candidate) => candidate.item.id).sort()).toEqual(
      [item.id, sibling.data.item.id].sort(),
    );
  });
});
