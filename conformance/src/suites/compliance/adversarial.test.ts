import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MarfaClient } from "../../client/api.js";
import type { TestContext } from "../../client/types.js";
import { createTestContext, trackItem, cleanup } from "../../utils/setup.js";
import { createNote } from "../../generators/items.js";
import { ofetch } from "ofetch";

let client: MarfaClient;
let ctx: TestContext;
let baseUrl: string;
let apiKey: string;

beforeAll(async () => {
  ({
    ctx,
    client,
    apiUrl: baseUrl,
    apiKey,
  } = await createTestContext("compliance", "adversarial"));
});

afterAll(async () => {
  await cleanup(ctx);
});

/** Write a note body and read it back; the stored text must be identical. */
async function roundTrip(body: string): Promise<void> {
  const r = await client.createItem(
    createNote({
      source: ctx.source,
      properties: { title: "round trip", body },
    }),
  );
  expect(r.ok).toBe(true);
  trackItem(ctx, r.data.item.id);
  const fetched = await client.getItem(r.data.item.id);
  expect(fetched.ok).toBe(true);
  expect(fetched.data.item.properties.body).toBe(body);
}

describe("adversarial input — large properties", () => {
  it("refuses a body over the field's length cap with invalid_properties", async () => {
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Large test", body: "x".repeat(500_000) },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error?.error.code).toBe("invalid_properties");
    const errors = r.error?.error.details?.errors as
      Array<{ field: string }> | undefined;
    expect(errors?.map((e) => e.field)).toContain("body");
  });

  it("refuses a request over the body cap with request_too_large", async () => {
    const r = await client.createItem(
      createNote({
        source: ctx.source,
        properties: { title: "Oversized", body: "x".repeat(1_100_000) },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(413);
    expect(r.error?.error.code).toBe("request_too_large");
  });
});

describe("adversarial input — Unicode edge cases", () => {
  it("stores emoji and ZWJ sequences unchanged", async () => {
    await roundTrip("🎉🇬🇧👨‍👩‍👧‍👦🏴󠁧󠁢󠁳󠁣󠁴󠁿 Emoji test with ZWJ sequences 🧑‍💻");
  });

  it("stores mixed RTL and LTR text unchanged", async () => {
    await roundTrip("مرحبا بالعالم - שלום עולם - Mixed LTR and RTL text");
  });

  it("stores zero-width characters unchanged", async () => {
    await roundTrip("visible​text‌with‍zero﻿width chars");
  });

  it("stores HTML and script text as plain data, unchanged", async () => {
    await roundTrip(
      '<script>alert("xss")</script><img onerror="alert(1)" src="x">',
    );
  });
});

describe("adversarial input — malformed requests", () => {
  it("malformed JSON body returns 400 validation_error", async () => {
    const response = await ofetch.raw(`${baseUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "this is not json at all {{{",
      ignoreResponseError: true,
    });

    expect(response.status).toBe(400);
    const body = response._data as { error?: { code?: string } } | undefined;
    expect(body?.error?.code).toBe("validation_error");
  });

  it("empty body POST returns 400 validation_error", async () => {
    const response = await ofetch.raw(`${baseUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: "",
      ignoreResponseError: true,
    });

    expect(response.status).toBe(400);
    const body = response._data as { error?: { code?: string } } | undefined;
    expect(body?.error?.code).toBe("validation_error");
  });

  it("array instead of object returns 400 validation_error", async () => {
    const response = await ofetch.raw(`${baseUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([{ type: "not-an-item" }]),
      ignoreResponseError: true,
    });

    expect(response.status).toBe(400);
    const body = response._data as { error?: { code?: string } } | undefined;
    expect(body?.error?.code).toBe("validation_error");
  });

  it("valid JSON with no type returns 400 missing_required_field", async () => {
    const response = await ofetch.raw(`${baseUrl}/items`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ foo: "bar", baz: 123 }),
      ignoreResponseError: true,
    });

    expect(response.status).toBe(400);
    const body = response._data as { error?: { code?: string } } | undefined;
    expect(body?.error?.code).toBe("missing_required_field");
  });
});
