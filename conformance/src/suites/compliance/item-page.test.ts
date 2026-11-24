import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createNote } from "../../generators/items.js";
import { createTestContext, cleanup, trackItem } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;
let apiUrl: string;
let instanceId: string;

beforeAll(async () => {
  ({ ctx, client, apiUrl } = await createTestContext(
    "compliance",
    "item-page",
  ));
  const root = await fetch(`${apiUrl}/`);
  instanceId = ((await root.json()) as { instance_id: string }).instance_id;
});

afterAll(async () => {
  await cleanup(ctx);
});

const asBrowser = { accept: "text/html" };

/** What one answer to the page says, with what differs between any two answers set aside. */
interface Seen {
  status: number;
  headers: [string, string][];
  page: string;
}

/**
 * The status, the headers and the page, with the id, the nonce, the request
 * id and the date set aside: each answer names its own, and none says
 * anything about the item.
 */
async function seen(
  path: string,
  id: string,
  headers: Record<string, string> = asBrowser,
): Promise<Seen> {
  const response = await fetch(`${apiUrl}${path}`, {
    headers,
    redirect: "manual",
  });
  const mask = (text: string): string =>
    text
      .split(id)
      .join("<id>")
      .replace(/nonce-[0-9a-f]+/g, "nonce-<nonce>");
  return {
    status: response.status,
    headers: [...response.headers.entries()]
      .filter(([name]) => name !== "date" && name !== "x-request-id")
      .map(([name, value]): [string, string] => [name, mask(value)])
      .sort(([a], [b]) => a.localeCompare(b)),
    page: mask(await response.text()).replace(
      /nonce="[0-9a-f]+"/g,
      'nonce="<nonce>"',
    ),
  };
}

function ownerCookie(): string {
  const cookie = process.env.MARFA_OWNER_COOKIE;
  expect(cookie, "MARFA_OWNER_COOKIE is required").toBeTruthy();
  return cookie!;
}

describe("the page that opens an item in an app", () => {
  it("answers a well-formed id with a page that links to marfa://<instance_id>/<id>", async () => {
    const id = uuidv7();
    const response = await fetch(`${apiUrl}/i/${id}`, { headers: asBrowser });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    const link = `marfa://${instanceId}/${id}`;
    expect(page).toMatch(
      new RegExp(`<a\\b[^>]*\\shref="${link}"[^>]*>Open in Marfa</a>`),
    );
    expect(page).toMatch(
      new RegExp(`<meta http-equiv="refresh" content="0;url=${link}">`),
    );
    expect(page).toContain("no app on this device opens Marfa links");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("answers an item that exists, a trashed one, a purged one and an id never used with one page", async () => {
    const made = await client.createItem(createNote({ source: ctx.source }));
    expect(made.ok, JSON.stringify(made.error)).toBe(true);
    const existing = made.data.item.id;
    trackItem(ctx, existing);
    const trashed = (
      await client.createItem(createNote({ source: ctx.source }))
    ).data.item.id;
    trackItem(ctx, trashed);
    const purged = (await client.createItem(createNote({ source: ctx.source })))
      .data.item.id;
    trackItem(ctx, purged);
    expect((await client.deleteItem(trashed)).ok).toBe(true);
    expect((await client.deleteItem(purged)).ok).toBe(true);
    expect((await client.purgeItem(purged)).ok).toBe(true);
    const never = uuidv7();

    // The witness: the item is there to be found by its id, in each state
    // the page is asked about, so a page that differed by state would differ.
    const found = await client.getItem(existing);
    expect(found.ok).toBe(true);
    expect((await client.getItem(trashed, "trashed")).ok).toBe(true);
    expect((await client.getItem(purged, "any")).ok).toBe(false);
    expect((await client.getItem(never)).ok).toBe(false);

    const answers = await Promise.all(
      [existing, trashed, purged, never].map((id) => seen(`/i/${id}`, id)),
    );
    expect(answers[0]?.status).toBe(200);
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  it("answers a signed-in browser as it answers a stranger", async () => {
    const id = (await client.createItem(createNote({ source: ctx.source })))
      .data.item.id;
    trackItem(ctx, id);

    // The witness: this cookie is the owner's live session, which the
    // root's page shows by naming the owner.
    const root = await fetch(`${apiUrl}/`, {
      headers: { ...asBrowser, cookie: ownerCookie() },
    });
    expect(await root.text()).toContain("Signed in as");

    const stranger = await seen(`/i/${id}`, id);
    const owner = await seen(`/i/${id}`, id, {
      ...asBrowser,
      cookie: ownerCookie(),
    });
    expect(stranger.status).toBe(200);
    expect(owner).toEqual(stranger);
    expect(owner.headers.map(([name]) => name)).not.toContain("set-cookie");
  });

  it("answers text that is not a well-formed id with a 404 page", async () => {
    const id = uuidv7();
    const malformed = [
      "/i/",
      "/i/not-an-id",
      `/i/${id.toUpperCase()}`,
      `/i/${id}/`,
      `/i/${id}/extra`,
      `/i/${[...id].map((c) => `%${c.charCodeAt(0).toString(16)}`).join("")}`,
      `/i/${id}%20`,
      `/i/${"a".repeat(4000)}`,
    ];
    const first = await fetch(`${apiUrl}/i/not-an-id`, { headers: asBrowser });
    const firstPage = await first.text();
    for (const path of malformed) {
      const response = await fetch(`${apiUrl}${path}`, { headers: asBrowser });
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toContain("text/html");
      expect(response.headers.get("cache-control"), path).toBe("no-store");
      expect(response.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(response.headers.get("x-robots-tag"), path).toBe("noindex");
      const page = await response.text();
      expect(page, path).toContain("This is not a Marfa link");
      expect(page, path).not.toContain("marfa://");
      for (const text of path.slice(3).split(/[/%]/)) {
        if (text.length > 3) expect(page, path).not.toContain(text);
      }
      expect(page.replace(/nonce="[0-9a-f]+"/g, ""), path).toBe(
        firstPage.replace(/nonce="[0-9a-f]+"/g, ""),
      );
    }

    // The witness: the same address is a link once the id is well formed.
    const well = await fetch(`${apiUrl}/i/${id}`, { headers: asBrowser });
    expect(well.status).toBe(200);
  });

  it("ignores a query string", async () => {
    const id = uuidv7();
    const plain = await seen(`/i/${id}`, id);
    const hostile = "<script>alert(1)</script>";
    const asked = await seen(
      `/i/${id}?next=${encodeURIComponent(hostile)}&id=${id}`,
      id,
    );
    expect(plain.status).toBe(200);
    expect(asked).toEqual(plain);
    expect(asked.page).not.toContain("alert(1)");

    const refused = await fetch(
      `${apiUrl}/i/not-an-id?x=${encodeURIComponent(hostile)}`,
      { headers: asBrowser },
    );
    expect(refused.status).toBe(404);
    expect(await refused.text()).not.toContain("alert(1)");
  });
});
