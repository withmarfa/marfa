import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";

let client: MarfaClient;
let ctx: TestContext;

beforeAll(async () => {
  ({ ctx, client } = await createTestContext(
    "compliance",
    "media-rating-game",
  ));
});

afterAll(async () => {
  await cleanup(ctx);
});

async function create(type: string, properties: Record<string, unknown>) {
  const created = await client.createItem({
    type,
    source: ctx.source,
    properties,
  });
  if (created.ok) trackItem(ctx, created.data.item.id);
  return created;
}

const MEDIA_TYPES = [
  "core.media",
  "core.media.album",
  "core.media.article",
  "core.media.book",
  "core.media.episode",
  "core.media.film",
  "core.media.game",
  "core.media.series",
  "core.media.song",
];

describe("the rating of a media item", () => {
  it("is an optional integer from 1 to 5 on core.media and every type under it", async () => {
    for (const id of MEDIA_TYPES) {
      const read = await client.getType(id);
      expect(read.status, id).toBe(200);
      expect(read.data.fields.rating, id).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 5,
      });
      expect(read.data.fields.rating?.required, id).toBeUndefined();
    }
  });

  it.each([1, 3, 5])(
    "takes a book rated %s and reads it back",
    async (rating) => {
      const book = await create("core.media.book", { title: "Rated", rating });
      expect(book.status, JSON.stringify(book.error)).toBe(201);
      expect(book.data.item.properties.rating).toBe(rating);
    },
  );

  it.each([0, 6, 3.5, "3"])(
    "refuses a rating of %s, naming rating",
    async (rating) => {
      const refused = await create("core.media.book", {
        title: "Rated",
        rating,
      });
      expect(refused.status).toBe(400);
      expect(refused.error?.error.code).toBe("invalid_properties");
      expect(JSON.stringify(refused.error)).toContain("rating");
    },
  );
});

describe("the game type", () => {
  it("lists core.media.game beneath core.media", async () => {
    const listed = await client.listTypes();
    expect(listed.status).toBe(200);
    const game = listed.data.data.find((t) => t.id === "core.media.game");
    expect(game?.parent).toBe("core.media");
    expect(game?.label).toBeTruthy();
  });

  it("declares its own fields and inherits progress and rating", async () => {
    const read = await client.getType("core.media.game");
    expect(read.data.fields.platforms).toMatchObject({
      type: "array",
      items_type: "string",
    });
    for (const name of ["min_players", "max_players"]) {
      expect(read.data.fields[name], name).toMatchObject({
        type: "integer",
        minimum: 1,
      });
    }
    expect(read.data.fields.progress?.type).toBe("status");
    expect(read.data.fields.rating?.type).toBe("integer");
  });

  it("takes a game on two platforms for one to four players", async () => {
    const properties = {
      title: "A game",
      platforms: ["Nintendo Switch", "PC"],
      min_players: 1,
      max_players: 4,
      progress: "started",
      rating: 4,
    };
    const game = await create("core.media.game", properties);
    expect(game.status, JSON.stringify(game.error)).toBe(201);
    expect(game.data.item.properties).toMatchObject(properties);
  });

  it("takes a game with a title alone", async () => {
    const game = await create("core.media.game", { title: "Only a title" });
    expect(game.status, JSON.stringify(game.error)).toBe(201);
  });

  it("is found by a listing of core.media", async () => {
    const game = await create("core.media.game", { title: "Listed game" });
    expect(game.status, JSON.stringify(game.error)).toBe(201);
    const listed = await client.listItems({ type: "core.media" });
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    expect(listed.data.data.map((item) => item.id)).toContain(
      game.data.item.id,
    );
  });

  it.each([
    ["min_players", 0],
    ["min_players", -1],
    ["min_players", 1.5],
    ["max_players", 0],
    ["max_players", -2],
    ["max_players", 2.5],
  ])("refuses %s of %s, naming the field", async (field, value) => {
    const refused = await create("core.media.game", {
      title: "A game",
      [field]: value,
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(JSON.stringify(refused.error)).toContain(field);
  });

  it("refuses a platform that is not text, naming the field and the position", async () => {
    const refused = await create("core.media.game", {
      title: "A game",
      platforms: ["PC", 7],
    });
    expect(refused.status).toBe(400);
    expect(refused.error?.error.code).toBe("invalid_properties");
    expect(JSON.stringify(refused.error)).toContain("platforms.1");
  });
});
