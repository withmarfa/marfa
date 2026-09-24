import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  KEY,
  hashOf,
  hydratedHarness,
  scriptBlob,
  startHarness,
  scriptHydration,
  scriptWrites,
  type Harness,
} from "./harness.js";
import {
  SCRIPTED_TYPES,
  snapshotType,
  answers,
  connected,
  heldLog,
  itemEvent,
  refusal,
  replay,
  streamCursor,
  wireItem,
  wireType,
  writeAnswers,
} from "../../device/marfa-answers.js";

/** One `core.file` row naming `hash`, for a hydration to pull. */
function hydrateOneFile(server: Harness["server"], hash: string): void {
  scriptHydration(server, {
    head: "10",
    rows: {
      "core.file": [
        {
          item: {
            id: "file-row",
            type: "core.file",
            properties: {
              title: "notes.txt",
              blob_ref: hash,
              mime_type: "text/plain",
            },
          },
        },
      ],
    },
  });
}

/**
 * "A device holds a working copy": one slice of one server, and nothing else.
 *
 * The slice is what makes a small app small and what keeps a phone from
 * holding a library. A device that quietly held a row outside its slice would
 * be a device whose size nobody can predict from what it declared, and one
 * that quietly dropped a row inside it would be a device that answers a
 * question wrongly with no way for the caller to tell.
 */

let harness: Harness | undefined;

/**
 * A PNG's signature, then base64 that spells `word`: `/` makes the word a
 * token of its own. Held as text, it is found by a search for the word, which
 * is what makes a thumbnail's absence from a search the thumbnail rule's
 * doing rather than the tokenizer's.
 */
const pngOf = (word: string) => `data:image/png;base64,iVBORw0KGgoA/${word}`;

afterEach(async () => {
  await harness?.stop();
  harness = undefined;
});

describe("the working copy holds one slice", () => {
  it("holds the declared types and their subtrees and nothing else", async () => {
    harness = await startHarness("slice-types");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("13", [
        // The control. A row of a declared type has to land, or every
        // assertion below passes against a device that applied nothing at all.
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "note", type: "core.note" }),
        ),
        itemEvent(
          "12",
          "item.created",
          wireItem({ id: "image", type: "core.file.image" }),
        ),
        itemEvent(
          "13",
          "item.created",
          wireItem({ id: "bookmark", type: "core.bookmark" }),
        ),
      ]),
    );

    expect(
      (await device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(true);
    const caught = await device.catchUp();
    expect(
      caught.ok,
      `the catch-up was refused: ${JSON.stringify(caught)}`,
    ).toBe(true);

    const held = await device.list();
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id).sort() : [];
    expect(
      ids,
      "a declared type, or the subtype under it, is missing from the copy, so a caller reading the slice it asked for is short rows the server announced",
    ).toContain("note");
    expect(
      ids,
      "a subtype of a declared type was not held, so declaring a type does not declare its subtree and every app has to name every child",
    ).toContain("image");
    expect(
      ids,
      "a row of a type outside the slice was held, so the copy grows past what the device declared and no app can predict its own size",
    ).not.toContain("bookmark");
  });

  it("holds one tier and not the other", async () => {
    harness = await startHarness("slice-tier");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    server.answer(
      "GET",
      "/events",
      replay("12", [
        // The control, again: without a library row landing, an empty copy
        // would satisfy the assertion about the feed row.
        itemEvent(
          "11",
          "item.created",
          wireItem({ id: "library-row", tier: "library" }),
        ),
        itemEvent(
          "12",
          "item.created",
          wireItem({ id: "feed-row", tier: "feed" }),
        ),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.list();
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id) : [];
    expect(
      ids,
      "the tier the device declared was not held, so the assertion below passes against an empty copy rather than against a device that keeps its tier",
    ).toContain("library-row");
    expect(
      ids,
      "a row of the other tier was held, so a device that asked for the library is carrying the feed as well",
    ).not.toContain("feed-row");
  });

  it("keeps an item however old it is", async () => {
    harness = await startHarness("no-expiry");
    const { server, device } = harness;
    // Four years before the log's retention could reach, and older than any
    // window a sweeper would plausibly be given.
    const ancient = "2022-01-01T00:00:00.000Z";
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: {
              id: "ancient",
              occurred_at: ancient,
              created_at: ancient,
              updated_at: ancient,
            },
          },
          { item: { id: "recent" } },
        ],
      },
    });
    server.answer(
      "GET",
      "/events",
      replay("11", [
        itemEvent("11", "item.created", wireItem({ id: "newest" })),
      ]),
    );

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.catchUp()).ok).toBe(true);

    const held = await device.list({ allStates: true });
    expect(held.ok).toBe(true);
    const ids = held.ok ? held.value.map((item) => item.id).sort() : [];
    // The control: the rows a sweeper would have kept are there, so a missing
    // old row is an expiry rather than a copy that never landed.
    expect(
      ids,
      "the recent rows are missing, so this says nothing about the old one",
    ).toEqual(expect.arrayContaining(["newest", "recent"]));
    expect(
      ids,
      "an item was dropped for being old, so a device removes rows the server still holds and goes on reporting the slice as complete",
    ).toContain("ancient");
  });

  it("holds the thumbnail an item carries", async () => {
    harness = await startHarness("thumbnail");
    const { server, device } = harness;
    // A registered type declaring a thumbnail, answered before the
    // hydration's own catalog, which it replaces for the one read a
    // hydration makes.
    server.answer("GET", "/types", {
      kind: "json",
      status: 200,
      body: {
        data: [...SCRIPTED_TYPES, snapshotType()],
        next_cursor: null,
      },
    });
    const image = pngOf("unicornsXYZ");
    scriptHydration(server, {
      head: "10",
      rows: {
        "user.snapshot": [
          {
            item: {
              id: "snap",
              type: "user.snapshot",
              properties: {
                title: "Holiday",
                thumbnail: image,
              },
            },
          },
        ],
        "core.note": [
          {
            item: {
              id: "beside",
              properties: { title: "Beside", body: image },
            },
          },
        ],
      },
    });
    expect(
      (await device.hydrate(["user.snapshot", "core.note"], "library")).ok,
    ).toBe(true);
    const asked = server.requests.length;

    const out = `${device.store}.thumbnail.png`;
    const held = await device.thumbnail("snap", out);
    expect(held.ok, JSON.stringify(held)).toBe(true);
    if (!held.ok) return;
    expect(held.value.thumbnail?.mime_type).toBe("image/png");
    expect(
      readFileSync(out),
      "the thumbnail's bytes are not the image the item carried",
    ).toEqual(Buffer.from(image.replace(/^data:[^,]*,/, ""), "base64"));
    expect(
      server.requests.length,
      "the thumbnail was fetched rather than read from the item held",
    ).toBe(asked);

    // An item whose type declares none carries none, and an item the copy
    // does not hold is refused as that rather than answered as one that
    // carries none.
    const none = await device.thumbnail("beside", `${out}.none`);
    expect(none.ok && none.value.thumbnail).toBeNull();
    const absent = await device.thumbnail("not-held", `${out}.absent`);
    expect(
      absent.ok ? "answered" : absent.refusal.code,
      "the thumbnail of an item the copy does not hold was answered, or refused as though the server had said so",
    ).toBe("not_held");

    // The image's base64 is not searchable. The witness: the same image
    // held as a note's text is found.
    const hits = await device.search("unicornsXYZ");
    expect(hits.ok).toBe(true);
    if (!hits.ok) return;
    const ids = hits.value.map((hit) => hit.item.id);
    expect(
      ids,
      "the image held as text was not found either, so nothing here is about the thumbnail",
    ).toContain("beside");
    expect(
      ids,
      "a search matched the thumbnail's base64, so every image answers searches for whatever its encoding happens to spell",
    ).toEqual(["beside"]);
  });

  it("keeps a thumbnail out of its index when its type arrives after the stream opened", async () => {
    harness = await startHarness("thumbnail-late-type");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    // The type is registered after the device's catalog was read: the
    // hydration and the first stream read it without the type, and every read
    // after with it. Queued behind the hydration's own catalog answer, which
    // the hydration takes.
    const late = wireType("core.note.snapshot", {
      parent: "core.note",
      titleField: "title",
      fields: {
        title: { type: "string" },
        body: { type: "string" },
        thumbnail: { type: "thumbnail" },
      },
    });
    let reads = 0;
    server.answer("GET", "/types", () => {
      reads += 1;
      return {
        kind: "json",
        status: 200,
        body: {
          data: reads <= 1 ? [...SCRIPTED_TYPES] : [...SCRIPTED_TYPES, late],
          next_cursor: null,
        },
      };
    });
    server.answer(
      "GET",
      "/events",
      heldLog([
        itemEvent(
          "11",
          "item.created",
          wireItem({
            id: "late",
            type: "core.note.snapshot",
            properties: {
              title: "Late",
              body: "zebraword",
              thumbnail: "data:image/png;base64,iVBORw0KGgoA/unicornsXYZ",
            },
          }),
        ),
      ]),
    );
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    expect((await device.follow(4)).ok).toBe(true);
    // The witness that the late read answered: the stream read the catalog
    // again after the event named a type it did not hold.
    expect(reads).toBeGreaterThan(1);

    const found = async (query: string): Promise<string[]> => {
      const hits = await device.search(query);
      return hits.ok ? hits.value.map((hit) => hit.item.id) : [];
    };
    // The witness: the item is held and indexed.
    expect(await found("zebraword")).toEqual(["late"]);
    expect(
      await found("unicornsXYZ"),
      "a thumbnail of a type the device learned only after its item arrived stayed in the index",
    ).toEqual([]);
  });

  it("keeps a thumbnail out of its index when its type gains one after the stream opened", async () => {
    harness = await startHarness("thumbnail-gained");
    const { server, device } = harness;
    const photo = (thumbnail: boolean) =>
      wireType("user.photo", {
        fields: {
          title: { type: "string" },
          body: { type: "string" },
          ...(thumbnail ? { thumbnail: { type: "thumbnail" } } : {}),
        },
      });
    // The type gains its thumbnail after the device read the catalog: the
    // hydration and the first stream read it without one, every read after
    // with it.
    let reads = 0;
    scriptHydration(server, {
      head: "10",
      rows: {
        "user.photo": [
          {
            item: {
              id: "photo",
              type: "user.photo",
              properties: { title: "Holiday", body: "as hydrated" },
            },
          },
        ],
      },
      catalog: {
        kind: "json",
        status: 200,
        body: { data: [...SCRIPTED_TYPES, photo(false)], next_cursor: null },
      },
    });
    server.answer("GET", "/types", () => {
      reads += 1;
      return {
        kind: "json",
        status: 200,
        body: {
          data: [...SCRIPTED_TYPES, photo(reads > 1)],
          next_cursor: null,
        },
      };
    });
    server.answer(
      "GET",
      "/events",
      heldLog([
        itemEvent(
          "11",
          "item.updated",
          wireItem({
            id: "photo",
            type: "user.photo",
            version: 2,
            properties: {
              title: "Holiday",
              body: "zebraword",
              thumbnail: "data:image/png;base64,iVBORw0KGgoA/unicornsXYZ",
            },
          }),
        ),
      ]),
    );
    expect((await device.hydrate(["user.photo"], "library")).ok).toBe(true);
    const followed = await device.follow(3);
    expect(followed.ok, JSON.stringify(followed)).toBe(true);
    // The witness that the catalog was read again after the event named an
    // image under a property it did not know as the thumbnail.
    expect(reads, "the follow never read the catalog again").toBeGreaterThan(1);

    const found = async (query: string): Promise<string[]> => {
      const hits = await device.search(query);
      return hits.ok ? hits.value.map((hit) => hit.item.id) : [];
    };
    // The witness: the event was applied and its row indexed.
    expect(await found("zebraword")).toEqual(["photo"]);
    expect(
      await found("unicornsXYZ"),
      "a type gained a thumbnail after the stream opened and the image's base64 went into the index",
    ).toEqual([]);
  });

  describe("keeps a thumbnail out of its index when the catalog was already read again for another image", () => {
    /** The catalog, holding `user.photo` with `cover` as its thumbnail or
     *  without a thumbnail at all. */
    const photos = (withCover: boolean) => ({
      kind: "json" as const,
      status: 200,
      body: {
        data: [
          ...SCRIPTED_TYPES,
          wireType("user.photo", {
            fields: {
              title: { type: "string" },
              body: { type: "string" },
              ...(withCover ? { cover: { type: "thumbnail" } } : {}),
            },
          }),
        ],
        next_cursor: null,
      },
    });
    // An image under a property the type never declares, which sends the
    // device to the catalog once and is then taken as the text it is.
    const icon = pngOf("iconwordXYZ");
    const cover = pngOf("unicornsXYZ");
    const photo = (id: string, properties: Record<string, unknown>) =>
      wireItem({ id, type: "user.photo", properties });
    const found = async (query: string): Promise<string[]> => {
      const hits = await harness?.device.search(query);
      return hits?.ok ? hits.value.map((hit) => hit.item.id).sort() : [];
    };

    it("keeps a thumbnail out of its index when it follows, in one item, an image already read again for", async () => {
      harness = await startHarness("thumbnail-after-spent");
      const { server, device } = harness;
      scriptHydration(server, { head: "10", catalog: photos(false) });
      // `cover` becomes the thumbnail after the device's second read: the
      // one the stream opened with and the one `icon` sent it to.
      let reads = 0;
      server.answer("GET", "/types", () => {
        reads += 1;
        return photos(reads > 2);
      });
      server.answer(
        "GET",
        "/events",
        heldLog([
          itemEvent(
            "11",
            "item.created",
            photo("first", { title: "First", body: "as sent", icon }),
          ),
          // `icon` comes first, and the device has read the catalog again
          // for it already.
          itemEvent(
            "12",
            "item.created",
            photo("second", {
              title: "Second",
              body: "zebraword",
              icon,
              cover,
            }),
          ),
        ]),
      );
      expect((await device.hydrate(["user.photo"], "library")).ok).toBe(true);
      const followed = await device.follow(3);
      expect(followed.ok, JSON.stringify(followed)).toBe(true);
      // The witness: the event was applied and its row indexed, and an image
      // held as text is found, so the thumbnail's absence is its own.
      expect(await found("zebraword")).toEqual(["second"]);
      expect(await found("iconwordXYZ")).toEqual(["first", "second"]);
      expect(
        await found("unicornsXYZ"),
        "an image already read again for hid the thumbnail after it in the same item, and the thumbnail's base64 went into the index",
      ).toEqual([]);
      expect(
        reads,
        "the image after one already read again for, in the same item, did not send the device to the catalog",
      ).toBe(3);
    });

    it("keeps a thumbnail out of its index when its property was read again for before its type declared it", async () => {
      harness = await startHarness("thumbnail-declared-later");
      const { server, device } = harness;
      scriptHydration(server, { head: "10", catalog: photos(false) });
      // The type declares `cover` its thumbnail only after the device's
      // third read, which the third stream opened with.
      let reads = 0;
      server.answer("GET", "/types", () => {
        reads += 1;
        return photos(reads > 3);
      });
      const first = itemEvent(
        "11",
        "item.created",
        photo("first", { title: "First", body: "as sent", cover: icon }),
      );
      const second = itemEvent(
        "12",
        "item.created",
        photo("second", { title: "Second", body: "zebraword", cover }),
      );
      // The first stream meets `cover` and is opened again; the second takes
      // it as the text it still is and ends; the third, on a catalog read
      // just before the type declared it, carries an item written after.
      let opened = 0;
      server.answer("GET", "/events", (request) => {
        opened += 1;
        const after = BigInt(request.headers["last-event-id"] ?? "0");
        const log = opened <= 2 ? [first] : [first, second];
        return {
          kind: "sse",
          hold: opened !== 2,
          frames: [
            connected,
            ...log.filter((frame) => BigInt(frame.id ?? "0") > after),
          ],
        };
      });
      expect((await device.hydrate(["user.photo"], "library")).ok).toBe(true);
      const followed = await device.follow(4);
      expect(followed.ok, JSON.stringify(followed)).toBe(true);
      // The witness: the event was applied and its row indexed.
      expect(await found("zebraword")).toEqual(["second"]);
      expect(
        await found("unicornsXYZ"),
        "a property read again for in one stream was never read again for, so the thumbnail its type declared later went into the index",
      ).toEqual([]);
      expect(
        reads,
        "a stream met an image under a property read again for in an earlier stream and did not read the catalog again",
      ).toBe(4);
    });

    it("keeps a thumbnail out of its index when a catch-up meets it after an image already read again for", async () => {
      harness = await startHarness("thumbnail-catch-up-after-spent");
      const { server, device } = harness;
      scriptHydration(server, { head: "10", catalog: photos(false) });
      let reads = 0;
      server.answer("GET", "/types", () => {
        reads += 1;
        return photos(reads > 2);
      });
      server.answer(
        "GET",
        "/events",
        replay("12", [
          itemEvent(
            "11",
            "item.created",
            photo("first", { title: "First", body: "as sent", icon }),
          ),
          itemEvent(
            "12",
            "item.created",
            photo("second", {
              title: "Second",
              body: "zebraword",
              icon,
              cover,
            }),
          ),
        ]),
      );
      expect((await device.hydrate(["user.photo"], "library")).ok).toBe(true);
      const caught = await device.catchUp();
      expect(caught.ok, JSON.stringify(caught)).toBe(true);
      // The witness: the event was applied and its row indexed, and an image
      // held as text is found, so the thumbnail's absence is its own.
      expect(await found("zebraword")).toEqual(["second"]);
      expect(await found("iconwordXYZ")).toEqual(["first", "second"]);
      expect(
        await found("unicornsXYZ"),
        "an image already read again for hid the thumbnail after it in the same item, and the thumbnail's base64 went into the index",
      ).toEqual([]);
      expect(
        reads,
        "the image after one already read again for, in the same item, did not send the catch-up to the catalog",
      ).toBe(3);
    });
  });

  describe("keeps a thumbnail out of its index on every path that writes a row", () => {
    const catalog = {
      kind: "json" as const,
      status: 200,
      body: { data: [...SCRIPTED_TYPES, snapshotType()], next_cursor: null },
    };
    const image = pngOf("unicornsXYZ");
    const found = async (query: string): Promise<string[]> => {
      const hits = await harness?.device.search(query);
      return hits?.ok ? hits.value.map((hit) => hit.item.id) : [];
    };

    it("keeps a thumbnail out of its index when a catch-up applies it", async () => {
      harness = await startHarness("thumbnail-applied");
      const { server, device } = harness;
      scriptHydration(server, { head: "10", catalog });
      server.answer(
        "GET",
        "/events",
        replay("11", [
          itemEvent(
            "11",
            "item.created",
            wireItem({
              id: "applied",
              type: "user.snapshot",
              properties: { title: "zebraword", thumbnail: image },
            }),
          ),
        ]),
      );
      expect((await device.hydrate(["user.snapshot"], "library")).ok).toBe(
        true,
      );
      expect((await device.catchUp()).ok).toBe(true);
      // The witness: the event was applied and its row indexed.
      expect(await found("zebraword")).toEqual(["applied"]);
      expect(
        await found("unicornsXYZ"),
        "an applied event put the image's base64 into the index",
      ).toEqual([]);
    });

    it("keeps a thumbnail out of its index when a drain's answer carries it", async () => {
      harness = await startHarness("thumbnail-settled");
      const { server, device } = harness;
      scriptHydration(server, { head: "10", catalog });
      expect((await device.hydrate(["user.snapshot"], "library")).ok).toBe(
        true,
      );
      const created = await device.create({
        type: "user.snapshot",
        properties: { title: "Made here" },
      });
      expect(created.ok, JSON.stringify(created)).toBe(true);
      if (!created.ok) return;
      const id = created.value.item_id ?? "";
      // The server's row carries a title and an image the local one did
      // not, so what the index holds afterwards is what the answer wrote.
      scriptWrites(server, {
        create: [
          answers.created(
            wireItem({
              id,
              type: "user.snapshot",
              properties: { title: pngOf("zebraword"), thumbnail: image },
            }),
          ),
        ],
      });
      const drained = await device.drain();
      expect(drained.ok, JSON.stringify(drained)).toBe(true);
      // The witness: the answer's row was written and indexed, an image in
      // its title found as the text it is there.
      expect(await found("zebraword")).toEqual([id]);
      expect(
        await found("unicornsXYZ"),
        "the row a drain's answer carried put the image's base64 into the index",
      ).toEqual([]);
    });

    it("keeps a thumbnail out of its index when a local edit writes it", async () => {
      harness = await startHarness("thumbnail-edited");
      const { server, device } = harness;
      scriptHydration(server, {
        head: "10",
        catalog,
        rows: {
          "user.snapshot": [
            {
              item: {
                id: "edited",
                type: "user.snapshot",
                properties: { title: "Before" },
              },
            },
          ],
        },
      });
      expect((await device.hydrate(["user.snapshot"], "library")).ok).toBe(
        true,
      );
      const edit = await device.update("edited", {
        properties: { title: pngOf("zebraword"), thumbnail: image },
        version: 1,
      });
      expect(edit.ok, JSON.stringify(edit)).toBe(true);
      // The witness: the edit was laid over the row and indexed, an image in
      // its title found as the text it is there.
      expect(await found("zebraword")).toEqual(["edited"]);
      expect(
        await found("unicornsXYZ"),
        "a local edit put the image's base64 into the index",
      ).toEqual([]);
    });
  });

  it("says the bytes are absent rather than the item", async () => {
    harness = await startHarness("bytes-absent");
    const { server, device } = harness;
    const bytes = Buffer.from("the bytes of a note\n");
    const hash = scriptBlob(server, bytes);
    hydrateOneFile(server, hash);
    expect((await device.hydrate(["core.file"], "library")).ok).toBe(true);

    // A blob the server holds no bytes for is absent bytes too, not a
    // missing item.
    const unheld = hashOf(Buffer.from("never uploaded\n"));
    server.answer(
      "GET",
      `/blobs/${unheld}/url`,
      refusal(404, "blob_not_found", "no blob with this hash"),
    );
    const none = await device.blob(unheld);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.refusal.code).toBe("bytes_absent");

    await server.offline();
    const absent = await device.blob(hash);
    expect(
      absent.ok,
      "a device with no way to fetch the bytes answered as though it had them",
    ).toBe(false);
    if (!absent.ok) {
      expect(
        absent.refusal.code,
        `a device without the bytes said something other than that they are absent: ${absent.refusal.raw}`,
      ).toBe("bytes_absent");
      expect(
        absent.refusal.raw,
        "the refusal did not name the bytes it is about",
      ).toContain(hash);
    }
    const item = await device.get("file-row");
    expect(
      item.ok,
      "absent bytes made the item that names them unreadable, so a missing file reads as a missing item",
    ).toBe(true);
    if (item.ok) expect(item.value.properties.blob_ref).toBe(hash);

    // The witness: the same ask answered once the server is back, so the
    // refusal above is the bytes being absent and not a device that cannot
    // fetch bytes at all.
    await server.online();
    const fetched = await device.blob(hash);
    expect(
      fetched.ok,
      `the device could not fetch the bytes with the server back: ${JSON.stringify(fetched)}`,
    ).toBe(true);
    if (fetched.ok) expect(readFileSync(fetched.value.path)).toEqual(bytes);
  });

  it("says the bytes are absent when the link does not serve them", async () => {
    harness = await startHarness("bytes-link-fails");
    const { server, device } = harness;
    const bytes = Buffer.from("behind a link that has expired\n");
    const hash = hashOf(bytes);
    const hex = hash.slice("sha256:".length);
    server.answer(
      "GET",
      `/blobs/${hash}/url`,
      writeAnswers.link(`${server.url}/links/${hex}`),
    );
    // An object store refusing a signature that has run out.
    server.answer("GET", `/links/${hex}`, {
      kind: "bytes",
      status: 403,
      body: Buffer.from("<Error><Code>AccessDenied</Code></Error>"),
      contentType: "application/xml",
    });
    hydrateOneFile(server, hash);
    expect((await device.hydrate(["core.file"], "library")).ok).toBe(true);
    const fetched = await device.blob(hash);
    expect(
      server.requests.some((request) => request.pathname.startsWith("/links/")),
      "the link was never followed, so nothing here is about what it answered",
    ).toBe(true);
    expect(fetched.ok).toBe(false);
    if (!fetched.ok) {
      expect(
        fetched.refusal.code,
        "a link that would not serve the bytes was reported as something other than absent bytes",
      ).toBe("bytes_absent");
    }
  });

  it("answers a second ask for the same bytes from what it holds", async () => {
    harness = await startHarness("bytes-held");
    const { server, device } = harness;
    const bytes = Buffer.from("fetched once\n");
    const hash = hashOf(bytes);
    const hex = hash.slice("sha256:".length);
    // A link spelled the way an object store signs one, which a device that
    // rebuilt the URL would spell differently.
    const link = `/links/${hex}?X-Sig=a%2Fb%3D&Expires=1`;
    server.answer(
      "GET",
      `/blobs/${hash}/url`,
      writeAnswers.link(`${server.url}${link}`),
    );
    server.answer("GET", `/links/${hex}`, {
      kind: "bytes",
      status: 200,
      body: bytes,
    });
    hydrateOneFile(server, hash);
    expect((await device.hydrate(["core.file"], "library")).ok).toBe(true);

    const first = await device.blob(hash);
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(
        first.value.path.startsWith(`${device.store}.blobs/`),
        "the bytes were not kept beside the working copy",
      ).toBe(true);
    }
    const followed = server.requests.find((request) =>
      request.pathname.startsWith("/links/"),
    );
    expect(
      followed?.target,
      "the link was not fetched exactly as the server gave it",
    ).toBe(link);
    expect(
      followed?.headers.authorization,
      "the device sent its credential to the link, which an object store's host must never see",
    ).toBeUndefined();
    // The witness: the device does carry its credential, to the server.
    expect(
      server.requests.find((request) => request.pathname.endsWith("/url"))
        ?.headers.authorization,
    ).toBeDefined();
    const asked = (): number =>
      server.requests.filter(
        (request) =>
          request.pathname.startsWith("/blobs/") ||
          request.pathname.startsWith("/links/"),
      ).length;
    // The witness: the first ask went to the server for the link and the
    // bytes, so the silence below is the second ask being answered locally.
    expect(asked(), "the first ask for the bytes made no request").toBe(2);

    await server.offline();
    const second = await device.blob(hash);
    expect(
      second.ok,
      `a second ask for bytes the device holds needed the server: ${JSON.stringify(second)}`,
    ).toBe(true);
    if (second.ok) expect(readFileSync(second.value.path)).toEqual(bytes);
    expect(asked()).toBe(2);
  });

  it("keeps no bytes that do not hash to the name they were fetched under", async () => {
    harness = await startHarness("bytes-altered");
    const { server, device } = harness;
    const bytes = Buffer.from("the bytes the name is for\n");
    const hash = scriptBlob(server, bytes, Buffer.from("something else\n"));
    hydrateOneFile(server, hash);
    expect((await device.hydrate(["core.file"], "library")).ok).toBe(true);

    const altered = await device.blob(hash);
    expect(
      altered.ok,
      "the device kept bytes that are not the blob they were fetched as, so the name answers a different file",
    ).toBe(false);
    // The link was followed, so the refusal is the check on what came back
    // and not a fetch that never happened.
    expect(
      server.requests.some((request) => request.pathname.startsWith("/links/")),
      "the device never followed the link, so nothing here is about what it does with what the link serves",
    ).toBe(true);
    await server.offline();
    const after = await device.blob(hash);
    expect(
      after.ok,
      "bytes refused for not matching their name were answered from the store on the next ask",
    ).toBe(false);
  });

  it("holds an item whose bytes it has not fetched", async () => {
    harness = await startHarness("blob-ref");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: {
        "core.file": [
          {
            item: {
              id: "file-row",
              type: "core.file",
              properties: {
                title: "notes.txt",
                blob_ref: `sha256:${"a".repeat(64)}`,
                mime_type: "text/plain",
              },
            },
          },
        ],
      },
    });

    expect((await device.hydrate(["core.file"], "library")).ok).toBe(true);
    const row = await device.get("file-row");
    expect(
      row.ok,
      `the item carrying a blob reference was not held: ${JSON.stringify(row)}`,
    ).toBe(true);
    if (row.ok) {
      expect(
        row.value.properties.blob_ref,
        "the item was held without the reference to its bytes, so nothing can fetch them later",
      ).toBe(`sha256:${"a".repeat(64)}`);
    }
    expect(
      server.requests.filter((request) =>
        request.pathname.startsWith("/blobs"),
      ),
      "the device fetched the bytes while hydrating, so a slice of a library would pull the library",
    ).toEqual([]);
  });
});

describe("the working copy belongs to one server", () => {
  it("binds to one origin and refuses a store opened against another", async () => {
    harness = await startHarness("origin");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const elsewhere = await startHarness("origin-other");
    try {
      const wrong = device.reopen({ url: elsewhere.server.url });
      const refused = await wrong.hydrate(["core.note"], "library");
      expect(
        refused.ok,
        "a store bound to one server accepted a hydration from another, so one file would carry two datasets with nothing recording which row came from where",
      ).toBe(false);
      if (!refused.ok) {
        expect(
          refused.refusal.code,
          `the device refused for some other reason, so nothing here shows it noticed the store belongs elsewhere: ${refused.refusal.raw}`,
        ).toBe("wrong_server");
        expect(
          refused.refusal.raw,
          "the refusal did not name the server the store belongs to, so a caller cannot tell which of the two is wrong",
        ).toContain(server.url);
        expect(
          refused.refusal.raw,
          "the refusal did not name the server that was offered",
        ).toContain(elsewhere.server.url);
      }
    } finally {
      await elsewhere.stop();
    }
  });

  it("keeps the key out of the store", async () => {
    harness = await startHarness("key-secrecy");
    const { server, device } = harness;
    scriptHydration(server, { head: "10" });
    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);

    const file = readFileSync(device.store).toString("latin1");
    // The control. Without it a store the search never reached, or one whose
    // bytes are unreadable here, would report the key absent from anything.
    expect(
      file,
      "the store does not carry the origin it is bound to, so this file is not the one the device wrote and the search below proves nothing",
    ).toContain(server.url.replace("http://", ""));
    expect(
      file.includes(KEY),
      "the key is written into the store, so a copied file carries the credential with it",
    ).toBe(false);
  });

  it("opens a store to read without claiming the writer role, and is told when it saves", async () => {
    harness = await hydratedHarness("reader-first", {
      rows: { "core.note": [{ item: { id: "n1" } }] },
    });
    // A path where nothing has been made: the reading open refuses it and
    // leaves nothing there. The witness: an ordinary open of such a path
    // makes the store.
    const made = `${harness.device.store}.made`;
    expect((await harness.device.reopen({ store: made }).status()).ok).toBe(
      true,
    );
    expect(existsSync(made)).toBe(true);
    const absent = `${harness.device.store}.absent`;
    const nowhere = await harness.device
      .reopen({ reader: true, store: absent })
      .status();
    expect(nowhere.ok, "a reading open answered for a path with no store").toBe(
      false,
    );
    if (!nowhere.ok) expect(nowhere.refusal.code).toBe("invalid");
    expect(existsSync(absent)).toBe(false);

    // Never writes, even where a writer died with a save still in its
    // journal and the reader is the last to close: a writer that closes
    // last folds the journal into the file, and a reader must not. The
    // hydration's head read is still the answer at the front, so the follow
    // reads it, waits, and asks again for this one.
    harness.server.answer("GET", "/events", {
      kind: "sse",
      hold: true,
      frames: [
        connected,
        itemEvent("11", "item.created", wireItem({ id: "journaled" })),
      ],
    });
    const dying = harness.device.holdFollow(20);
    try {
      await vi.waitFor(() => expect(dying.stdout).toContain('"cursor":"11"'), {
        timeout: 10_000,
        interval: 25,
      });
    } finally {
      await dying.stop();
    }
    const bytes = () => readFileSync(harness!.device.store);
    const untouched = bytes();
    const reading = harness.device.reopen({ reader: true });
    expect((await reading.status()).ok).toBe(true);
    expect((await reading.get("journaled")).ok).toBe(true);
    expect(
      bytes().equals(untouched),
      "a store opened to read was written",
    ).toBe(true);
    // The witness: the writer, closing last, folds the journal in.
    expect((await harness.device.status()).ok).toBe(true);
    expect(
      bytes().equals(untouched),
      "the writer closing last left the file as it was, so the check above proves nothing",
    ).toBe(false);

    // The helper starts first and waits for saves. `changes` opens to read
    // whether or not it is told to, so it starts here without `--reader`,
    // and the app starting after it is the writer all the same.
    const reader = harness.device.hold(["changes", "--for", "20"]);
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    try {
      await vi.waitFor(
        () => {
          expect(
            reader.stdout,
            `the reader never started watching: ${reader.stderr}`,
          ).toContain('"watching":true');
        },
        { timeout: 10_000, interval: 25 },
      );
      const told = () =>
        reader.stdout.split("\n").filter((line) => line.trim() !== "");
      // Many of its polls pass with nothing saved.
      await pause(1_000);
      expect(
        told(),
        "the reader reported a save before anything saved",
      ).toHaveLength(1);
      // Three saves a third of a second apart, each told once: a reader
      // that polled slowly would fold two into one, and one that forgot
      // what it had seen would tell each again at every poll.
      for (const title of ["first", "second", "third"]) {
        const wrote = await harness.device.create({
          type: "core.note",
          properties: { title, body: "saved" },
        });
        expect(
          wrote.ok,
          `a reader started first took the writer role, so the app cannot write to its own store: ${JSON.stringify(wrote)}`,
        ).toBe(true);
        await pause(350);
      }
      await vi.waitFor(
        () => {
          expect(
            told().length,
            "the writer saved and the reader was not told",
          ).toBeGreaterThanOrEqual(4);
        },
        { timeout: 5_000, interval: 50 },
      );
      await pause(1_000);
      expect(
        told(),
        "the reader told three saves a third of a second apart some other number of times",
      ).toHaveLength(4);
    } finally {
      await reader.stop();
    }
  });

  it("gives a second opener a reading handle that refuses writes", async () => {
    harness = await hydratedHarness("one-writer", {
      rows: { "core.note": [{ item: { id: "n1" } }] },
    });
    // A command that holds the store: a drain whose write the server accepts
    // and never answers. Every other command opens the store, does its work
    // and exits, so two of them never overlap and both are legitimately the
    // writer — the rule is about two at once, and nothing else here makes
    // that happen.
    const queued = await harness.device.create({
      type: "core.note",
      properties: { title: "held open", body: "held open" },
    });
    expect(queued.ok).toBe(true);
    harness.server.answer("POST", "/items", { kind: "stall" });
    const writer = harness.device.hold(["drain"]);

    try {
      await vi.waitFor(
        () => {
          expect(
            writer.running(),
            `the writer exited before it could hold anything: ${writer.stderr}`,
          ).toBe(true);
          expect(
            harness?.server.requests.some(
              (request) => request.method === "POST",
            ),
            "the held drain has not reached the server, so it may not have opened the store",
          ).toBe(true);
        },
        { timeout: 10_000, interval: 25 },
      );

      const second = harness.device.reopen();
      // It reads. A second opener is limited rather than refused, because a
      // file one process is writing is still a file another can read, and
      // refusing to open it would make a running watcher lock a person out
      // of their own copy.
      const listed = await second.list();
      expect(
        listed.ok,
        `a second opener could not read at all, so the store is locked rather than held by one writer: ${JSON.stringify(listed)}`,
      ).toBe(true);
      expect(listed.ok ? listed.value.length : 0).toBeGreaterThan(0);
      expect((await second.status()).ok).toBe(true);
      expect((await second.search("n1")).ok).toBe(true);

      // And it writes nothing.
      const wrote = await second.create({
        type: "core.note",
        properties: { title: "from the reader", body: "from the reader" },
      });
      expect(
        wrote.ok,
        "two processes both held the writer handle for one store, so both queue into one file and neither sees the other's rows",
      ).toBe(false);
      if (!wrote.ok) {
        expect(
          wrote.refusal.code,
          `the second opener was refused for some other reason, so nothing here shows it was given a reading handle: ${wrote.refusal.raw}`,
        ).toBe("reading_handle");
      }
      expect(
        writer.running(),
        "the process holding the writer handle exited while this ran, so the refusal above was a store with no writer rather than one with another",
      ).toBe(true);
    } finally {
      await writer.stop();
    }
  });
});

describe("the working copy says what it is", () => {
  it("reports its slice, cursor and hydration state before it has hydrated", async () => {
    harness = await startHarness("status-fresh");
    const status = await harness.device.status();
    expect(
      status.ok,
      `a device that has not hydrated could not report its own state: ${JSON.stringify(status)}`,
    ).toBe(true);
    if (!status.ok) return;
    expect(
      status.value.hydration,
      "a device that has never hydrated did not say so, so a caller cannot tell a hydration is owed",
    ).toBe("never");
    expect(
      status.value.slice_types,
      "a device that has declared nothing reported a slice, so its report is not a reading of what it holds",
    ).toEqual([]);
    expect(
      status.value.event_cursor ?? null,
      "a device with nowhere to resume from named a cursor, so a catch-up would replay from a point nothing chose",
    ).toBeNull();
    expect(
      status.value.server_origin ?? null,
      "a device that has hydrated from nowhere named a server it is bound to",
    ).toBeNull();
    expect(
      [status.value.items, status.value.edges],
      "a device that holds nothing reported holding something, so the counts are not a reading of the copy",
    ).toEqual([0, 0]);
  });

  it("refuses a read before any hydration", async () => {
    harness = await startHarness("read-before-hydration");
    const { device } = harness;

    // Every read door, because a refusal on one and an empty page on
    // another is the same wrong answer with a smaller blast radius.
    const listed = await device.list();
    expect(
      listed.ok,
      "a store that has never hydrated answered a listing, so a caller cannot tell an empty slice from a copy that was never pulled",
    ).toBe(false);
    if (!listed.ok) {
      expect(
        listed.refusal.code,
        `the read was refused for some other reason, so a caller is told to fix the wrong thing and never learns a hydration is owed: ${listed.refusal.raw}`,
      ).toBe("hydration_incomplete");
    }

    const found = await device.search("anything");
    expect(
      found.ok,
      "a store that has never hydrated answered a search, so an empty result set reads as a corpus with nothing in it",
    ).toBe(false);

    const got = await device.get("whatever");
    expect(
      got.ok,
      "a store that has never hydrated answered a read by id, so an absent row and a copy that was never pulled read the same",
    ).toBe(false);

    // The control: the device answers about itself before it has hydrated,
    // which is how a caller learns a hydration is owed (`device.md` 5). A
    // device that refused everything would satisfy the three above for a
    // reason that has nothing to do with the slice.
    const status = await device.status();
    expect(
      status.ok,
      "a device that has not hydrated could not report its own state, so the refusals above are a broken binary rather than the rule",
    ).toBe(true);
  });

  it("refuses a read after an interrupted hydration", async () => {
    harness = await startHarness("interrupted");
    const { server, device } = harness;
    server.answer("GET", "/events", {
      kind: "sse",
      frames: [connected, streamCursor("10")],
    });
    server.answer("GET", "/types", {
      kind: "json",
      status: 200,
      body: {
        data: [
          {
            id: "core.note",
            parent: null,
            label: "note",
            display_hints: {},
            fields: {},
          },
        ],
        next_cursor: null,
      },
    });
    // The snapshot dies partway: the first page lands, the second never
    // answers, which is what a device meets when a hydration is interrupted.
    server.answer("GET", "/items", { kind: "drop" });

    const hydrated = await device.hydrate(["core.note"], "library");
    expect(
      hydrated.ok,
      "the interrupted hydration reported success, so a caller is told it holds a slice that was never finished",
    ).toBe(false);

    const listed = await device.list();
    expect(
      listed.ok,
      "a store left half-hydrated answered a listing, so a caller reads a partial copy as though it were the slice",
    ).toBe(false);
    if (!listed.ok) {
      expect(
        listed.refusal.code,
        `the refusal did not say the hydration is incomplete: ${listed.refusal.raw}`,
      ).toBe("hydration_incomplete");
    }
  });

  it("reports an interrupted re-hydration as in progress, not as a copy that aged out", async () => {
    // The state the other three words are defined against. A hydration
    // clears the cursor before it reads a page and leaves the previous
    // slice declared, so a re-hydration that dies partway leaves a store
    // that declares a slice and holds no cursor — which is the shape of a
    // copy whose cursor aged out. The two are told apart by the marker, and
    // which of them wins is a claim `device.md` 5 makes in words.
    harness = await startHarness("interrupted-rehydration");
    const { server, device } = harness;
    scriptHydration(server, {
      head: "10",
      rows: { "core.note": [{ item: { id: "first" } }] },
    });
    // Queued behind the snapshot the first hydration takes: the server
    // hands out its answers in order, so the second hydration is the one
    // that dies partway.
    server.answer("GET", "/items", { kind: "drop" });

    expect((await device.hydrate(["core.note"], "library")).ok).toBe(true);
    const before = await device.status();
    expect(
      before.ok ? before.value.hydration : null,
      "the first hydration did not leave a complete copy, so what the second one leaves is not a statement about an interruption",
    ).toBe("complete");

    const second = await device.hydrate(["core.note"], "library");
    expect(
      second.ok,
      "the interrupted re-hydration reported success, so nothing below is a statement about an interrupted store",
    ).toBe(false);

    const after = await device.status();
    expect(
      after.ok,
      `the status door was refused after an interrupted re-hydration: ${JSON.stringify(after)}`,
    ).toBe(true);
    if (!after.ok) return;
    expect(
      after.value.hydration,
      "an interrupted re-hydration reported itself as a copy that aged out, so a caller is told to wait for a log it will never catch rather than to run the hydration again",
    ).toBe("in_progress");
    // The witness that this store really is the shape `expired` describes:
    // the slice is still declared and the cursor is gone, so the two words
    // are separated by the marker and not by the store being different.
    expect(
      after.value.slice_types,
      "the interrupted re-hydration cleared the slice too, so this store is not the one the two words compete over",
    ).toContain("core.note");
    expect(
      after.value.event_cursor ?? null,
      "the interrupted re-hydration left a cursor, so the same",
    ).toBeNull();
  });
});

describe("a local read answers the active state unless asked otherwise", () => {
  /**
   * Three rows, one per state, in one slice. Hydration asks the server for
   * every state (`device.md` 31), so what the copy holds is not in question
   * here and what a read answers is.
   */
  async function hydrateEveryState(label: string): Promise<void> {
    harness = await startHarness(label);
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          { item: { id: "live", properties: { title: "zqlocal live" } } },
          {
            item: {
              id: "filed",
              state: "archived",
              properties: { title: "zqlocal filed" },
            },
          },
          {
            item: {
              id: "binned",
              state: "trashed",
              properties: { title: "zqlocal binned" },
            },
          },
        ],
      },
    });
    expect(
      (await harness.device.hydrate(["core.note"], "library")).ok,
      "the hydration failed, so nothing below is a statement about a read",
    ).toBe(true);

    // The slice is a type list and a tier, never a state: a hydration that
    // asked for the default would land only active rows, and every read
    // below would then be answered by a copy that never held the others.
    // The scripted server honors the parameter, so this is what keeps the
    // widening under test rather than assumed.
    const itemReads = harness.server.requests.filter(
      (request) => request.pathname === "/items",
    );
    expect(
      itemReads.length,
      "the hydration read no items door at all, so the assertions below are about an empty copy",
    ).toBeGreaterThan(0);
    for (const read of itemReads) {
      expect(
        read.query.get("state"),
        "hydration stopped asking for every state, so a working copy holds only active rows and a caller can never reach the rest",
      ).toBe("any");
    }
  }

  /** Every id the copy holds, whatever state it is in. */
  async function heldIds(): Promise<string[]> {
    const everything = await harness!.device.list({ allStates: true });
    expect(
      everything.ok,
      `the widened local list was refused, so the control every absence below leans on says nothing: ${JSON.stringify(everything)}`,
    ).toBe(true);
    return everything.ok ? everything.value.map((item) => item.id).sort() : [];
  }

  it("answers the active state on a local list that names none", async () => {
    await hydrateEveryState("local-list-state-default");
    const device = harness!.device;

    const listed = await device.list();
    expect(
      listed.ok,
      `a plain local list was refused, so the ids below are an empty array and every assertion on them holds vacuously: ${JSON.stringify(listed)}`,
    ).toBe(true);
    const ids = listed.ok ? listed.value.map((item) => item.id).sort() : [];
    expect(
      ids,
      "a local list naming no state stopped answering live rows, so an unnarrowed read reports an empty copy",
    ).toContain("live");
    expect(
      ids,
      "a local list naming no state answers archived rows, so a device and the server it copies give different answers to one question",
    ).not.toContain("filed");
    expect(
      ids,
      "a local list naming no state answers the bin, so a deleted row still reads as present on the device",
    ).not.toContain("binned");

    // The copy holds all three, so the absences above are the read's doing
    // rather than a hydration that never landed them.
    expect(
      await heldIds(),
      "the widening flag does not widen, so the rows the default hides are unreachable and the case above proves nothing",
    ).toEqual(["binned", "filed", "live"]);

    const filed = await device.list({ state: "archived" });
    expect(
      filed.ok,
      `naming a state on the local list door was refused outright, so the door has no setting at all: ${JSON.stringify(filed)}`,
    ).toBe(true);
    expect(
      filed.ok ? filed.value.map((item) => item.id) : [],
      "naming a state no longer reaches it, so a caller cannot ask for the rows the default hides",
    ).toEqual(["filed"]);
  });

  it("answers the active state on a local search that names none", async () => {
    await hydrateEveryState("local-search-state-default");
    const device = harness!.device;

    // This case's own store, so the list case's control does not carry: a
    // hydration that stopped landing non-active rows would make both
    // absences below true for the wrong reason.
    expect(
      await heldIds(),
      "the copy does not hold the rows the search must not answer, so the absences below say nothing about the search",
    ).toEqual(["binned", "filed", "live"]);

    const hits = await device.search("zqlocal");
    expect(
      hits.ok,
      `a plain local search was refused, so the ids below are an empty array and every assertion on them holds vacuously: ${JSON.stringify(hits)}`,
    ).toBe(true);
    const ids = hits.ok ? hits.value.map((hit) => hit.item.id).sort() : [];
    expect(
      ids,
      "a local search stopped matching live rows, so the local index answers nothing and the absences below are vacuous",
    ).toContain("live");
    expect(
      ids,
      "a local search answers a row a local list hides, which is two answers to one question on one device",
    ).not.toContain("filed");
    expect(
      ids,
      "a local search answers the bin, so a deleted row is still findable on the device",
    ).not.toContain("binned");

    // A caller who names a state is answered it, which is what makes the
    // default a default rather than the only selection the door has.
    const filed = await device.search("zqlocal", { state: "archived" });
    expect(
      filed.ok,
      `naming a state on the local search door was refused outright, so the door has no setting at all: ${JSON.stringify(filed)}`,
    ).toBe(true);
    expect(
      filed.ok ? filed.value.map((hit) => hit.item.id) : [],
      "naming a state no longer reaches it on the local search door, so the rows the default hides are unreachable by any local read",
    ).toEqual(["filed"]);
  });

  it("keeps a row in the bin out of the index, whatever state a search names", async () => {
    await hydrateEveryState("local-search-bin");
    const device = harness!.device;

    // The copy holds it, so what follows is the index rather than the slice.
    expect(
      await heldIds(),
      "the copy does not hold the row in the bin, so a search that misses it proves nothing about the index",
    ).toContain("binned");

    for (const [named, filters] of [
      ["the widening", { allStates: true }],
      ["the bin by name", { state: "trashed" }],
    ] as const) {
      const hits = await device.search("zqlocal", filters);
      expect(
        hits.ok,
        `a local search naming ${named} was refused outright: ${JSON.stringify(hits)}`,
      ).toBe(true);
      if (!hits.ok) continue;
      const ids = hits.value.map((hit) => hit.item.id);
      expect(
        ids,
        `a local search naming ${named} answers a row in the bin, so a device matches text the server it copies answers nothing for`,
      ).not.toContain("binned");
    }

    // The control, and it is the whole point of the case: the widening does
    // reach the archive. Without it the two absences above would be
    // satisfied by a widening that reached nothing at all.
    const widened = await device.search("zqlocal", { allStates: true });
    expect(widened.ok).toBe(true);
    expect(
      widened.ok ? widened.value.map((hit) => hit.item.id).sort() : [],
      "the widening reaches neither the archive nor the bin, so it widens nothing and the absences above say nothing about the bin",
    ).toEqual(["filed", "live"]);
  });

  it("reads an archived row by id and reports a trashed one as absent", async () => {
    await hydrateEveryState("local-get-state");
    const device = harness!.device;

    const filed = await device.get("filed");
    expect(
      filed.ok,
      `a read by id was refused, so the assertion below is about a broken door rather than about the archive: ${JSON.stringify(filed)}`,
    ).toBe(true);
    expect(
      filed.ok ? filed.value.id : undefined,
      "an archived row is not readable by id, so a caller holding its id is told it does not exist while the server would hand it over",
    ).toBe("filed");

    const live = await device.get("live");
    expect(
      live.ok,
      "an ordinary read by id was refused, so the absence below is about a broken door rather than the bin",
    ).toBe(true);

    // The witness for the absence below, which the two cases above carry and
    // this one did not. Hydrating proves the request asked for every state;
    // it does not prove the row landed. Without this, a device that dropped
    // trashed rows on ingest would pass this case while having lost the row
    // from `--all-states` reads and from what a catch-up prunes against.
    expect(
      await heldIds(),
      "the copy does not hold the binned row at all, so the absence below is a row that never arrived rather than one the read refuses",
    ).toEqual(["binned", "filed", "live"]);

    const binned = await device.get("binned");
    expect(
      binned.ok && binned.value !== null,
      "a row in the bin is readable by id, so a device hands back a row the server it copies answers 404 for",
    ).toBe(false);
  });
});

describe("a local search narrows as a list does", () => {
  it("narrows a local search by type and tags as a list does", async () => {
    harness = await startHarness("search-narrowing");
    // A subtype by declared parent alone: its name shares no prefix with
    // `core.file`, so only the parent puts it in that subtree. Answered
    // before the hydration's own catalog, which it replaces for the one read
    // a hydration makes.
    harness.server.answer("GET", "/types", {
      kind: "json",
      status: 200,
      body: {
        data: [
          ...SCRIPTED_TYPES,
          wireType("user.photo", { parent: "core.file", titleField: "title" }),
        ],
        next_cursor: null,
      },
    });
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          {
            item: { id: "note", properties: { title: "heron note" } },
            tags: ["garden", "birds"],
          },
        ],
        "core.file": [
          {
            item: {
              id: "image",
              type: "core.file.image",
              properties: { title: "heron image" },
            },
            tags: ["birds"],
          },
          {
            item: {
              id: "file",
              type: "core.file",
              properties: { title: "heron file" },
            },
          },
          {
            item: {
              id: "photo",
              type: "user.photo",
              properties: { title: "heron photo" },
            },
            tags: ["garden"],
          },
        ],
      },
    });
    expect(
      (await harness.device.hydrate(["core.note", "core.file"], "library")).ok,
    ).toBe(true);
    const ids = async (filters: {
      type?: string;
      tags?: string[];
    }): Promise<string[]> => {
      const hits = await harness!.device.search("heron", filters);
      expect(
        hits.ok,
        `a narrowed local search was refused: ${JSON.stringify(hits)}`,
      ).toBe(true);
      return hits.ok ? hits.value.map((hit) => hit.item.id).sort() : [];
    };
    // The control: unnarrowed, the search finds all four, so every absence
    // below is the narrowing.
    expect(await ids({})).toEqual(["file", "image", "note", "photo"]);
    expect(
      await ids({ type: "core.file" }),
      "a search narrowed to a type answered another type, or dropped a subtype a list would answer, by name or by declared parent",
    ).toEqual(["file", "image", "photo"]);
    expect(
      await ids({ tags: ["birds"] }),
      "a search narrowed to a tag answered a row without it",
    ).toEqual(["image", "note"]);
    expect(
      await ids({ tags: ["birds", "garden"] }),
      "a search narrowed by two tags answered a row carrying only one of them",
    ).toEqual(["note"]);
    expect(
      await ids({ type: "core.note", tags: ["birds", "garden"] }),
      "a search narrowed by a type and two tags answered a row lacking one of them",
    ).toEqual(["note"]);
  });
});

describe("a local list narrows on the item's own time", () => {
  /**
   * Both bounds are exclusive, which is one rule across the whole API
   * (`search-and-filters.md` 6). A device that read either of them
   * inclusively would answer a bounded list differently from the server it
   * copies, and the row that tells the two apart is the one sitting exactly
   * on the instant.
   */
  const ON_LOWER = "2026-03-01T00:00:00.000Z";
  const INSIDE = "2026-03-02T00:00:00.000Z";
  const ON_UPPER = "2026-03-03T00:00:00.000Z";
  const OUTSIDE = "2026-03-09T00:00:00.000Z";

  async function hydrateFourRows(label: string): Promise<void> {
    harness = await startHarness(label);
    scriptHydration(harness.server, {
      head: "10",
      rows: {
        "core.note": [
          { item: { id: "on-lower", occurred_at: ON_LOWER } },
          { item: { id: "inside", occurred_at: INSIDE } },
          { item: { id: "on-upper", occurred_at: ON_UPPER } },
          { item: { id: "outside", occurred_at: OUTSIDE } },
        ],
      },
    });
    expect(
      (await harness.device.hydrate(["core.note"], "library")).ok,
      "the hydration failed, so nothing below is a statement about a bound",
    ).toBe(true);
  }

  it("excludes a row sitting exactly on either bound", async () => {
    await hydrateFourRows("bounds-exclusive");
    const listed = await harness!.device.list({
      occurredAfter: ON_LOWER,
      occurredBefore: ON_UPPER,
    });
    expect(
      listed.ok,
      `a bounded local list was refused: ${JSON.stringify(listed)}`,
    ).toBe(true);
    if (!listed.ok) return;
    const ids = listed.value.map((item) => item.id);

    // The witness. Without a row the query must return, both absences below
    // are satisfied by a bound that dropped its predicate and matched
    // nothing at all.
    expect(
      ids,
      "a bounded list answers nothing at all, so the exclusions below are free and say nothing about either bound",
    ).toContain("inside");
    expect(
      ids,
      "the lower bound is inclusive here and exclusive on the server, so a device and the server answer one query two ways",
    ).not.toContain("on-lower");
    expect(
      ids,
      "the upper bound is inclusive here and exclusive on the server, so the same query returns a different set on each side",
    ).not.toContain("on-upper");
    expect(
      ids,
      "a row outside the window came back, so the bounds narrow nothing",
    ).not.toContain("outside");
  });

  it("takes each bound on its own", async () => {
    await hydrateFourRows("bounds-single");
    const device = harness!.device;

    // One bound at a time, because a pair can agree by accident: a filter
    // that applied only the lower bound would pass the case above for the
    // upper one, since nothing there sits above the window and below it.
    const above = await device.list({ occurredAfter: ON_LOWER });
    expect(above.ok).toBe(true);
    if (above.ok) {
      const ids = above.value.map((item) => item.id);
      expect(
        ids,
        "a lower bound on its own drops rows above it, so it is narrowing something other than the item's own time",
      ).toEqual(expect.arrayContaining(["inside", "on-upper", "outside"]));
      expect(
        ids,
        "a lower bound on its own keeps the row sitting on it, so that bound alone is inclusive",
      ).not.toContain("on-lower");
    }

    const below = await device.list({ occurredBefore: ON_UPPER });
    expect(below.ok).toBe(true);
    if (below.ok) {
      const ids = below.value.map((item) => item.id);
      expect(
        ids,
        "an upper bound on its own drops rows below it, so it is narrowing something other than the item's own time",
      ).toEqual(expect.arrayContaining(["on-lower", "inside"]));
      expect(
        ids,
        "an upper bound on its own keeps the row sitting on it, so that bound alone is inclusive",
      ).not.toContain("on-upper");
    }
  });
});
