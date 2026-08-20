import { describe, it, expect } from "vitest";
import { IntegrationManifestSchema } from "@withmarfa/shared";
import {
  READWISE_READER_MANIFEST,
  INTEGRATION_NAME,
  DEFAULT_TARGET_TYPE,
  CHILD_CATEGORIES,
  WRITABLE_LOCATIONS,
  FABRICATED_URL_PREFIX,
  MAX_PAGES_PER_SWEEP,
  PAGE_SIZE,
} from "./manifest.js";

describe("readwise/reader manifest", () => {
  it("parses through the canonical schema", () => {
    const parsed = IntegrationManifestSchema.safeParse(
      READWISE_READER_MANIFEST,
    );
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("sits under the readwise handle, distinct from the highlights integration", () => {
    expect(INTEGRATION_NAME).toBe("readwise/reader");
    expect(READWISE_READER_MANIFEST.publisher).toBe("readwise");
    expect(INTEGRATION_NAME).not.toBe("readwise/highlights");
  });

  it("declares both directions and the triggers that carry them", () => {
    expect(READWISE_READER_MANIFEST.direction).toBe("both");
    const kinds = READWISE_READER_MANIFEST.triggers.map((t) => t.type).sort();
    expect(kinds).toEqual(["item-event", "schedule"]);
  });

  it("declares the item-event trigger that is the actual dispatch switch", () => {
    // Outbound dispatch keys on this trigger, not on `direction`. A
    // manifest that says `both` without it is silently inbound-only.
    expect(
      READWISE_READER_MANIFEST.triggers.some((t) => t.type === "item-event"),
    ).toBe(true);
  });

  it("targets only the Reader document type", () => {
    expect(READWISE_READER_MANIFEST.target_types).toEqual([
      DEFAULT_TARGET_TYPE,
    ]);
  });

  it("requires the readwise token capability", () => {
    expect(READWISE_READER_MANIFEST.token_requirements).toEqual({
      readwise: "required",
    });
    expect(READWISE_READER_MANIFEST.oauth_requirements).toEqual({});
  });

  it("ignores tombstones, because the v3 API publishes no deletion signal", () => {
    expect(
      READWISE_READER_MANIFEST.bidirectional_handling.tombstone_mapping,
    ).toBe("ignore");
  });

  it("carries echo and lag windows long enough to cover a read-back", () => {
    const { echo_ttl_seconds, lag_window_seconds } =
      READWISE_READER_MANIFEST.bidirectional_handling;
    expect(echo_ttl_seconds).toBe(120);
    expect(lag_window_seconds).toBe(600);
  });

  it("declares include_feed with a default of off", () => {
    const feed = READWISE_READER_MANIFEST.configuration_schema?.include_feed;
    expect(feed?.type).toBe("boolean");
    expect(feed?.default).toBe(false);
  });

  it("never treats shortlist as a writable location", () => {
    // Reader answers 201 and stores `new`. There is no error to catch,
    // so the guard has to be here.
    expect(WRITABLE_LOCATIONS.has("shortlist")).toBe(false);
    expect([...WRITABLE_LOCATIONS].sort()).toEqual([
      "archive",
      "feed",
      "later",
      "new",
    ]);
  });

  it("treats highlights and notes as child objects", () => {
    expect(CHILD_CATEGORIES.has("highlight")).toBe(true);
    expect(CHILD_CATEGORIES.has("note")).toBe(true);
    expect(CHILD_CATEGORIES.has("article")).toBe(false);
  });

  it("fabricates URLs in a namespace that cannot resolve", () => {
    // RFC 2606 reserves `.invalid` precisely so it never resolves.
    expect(FABRICATED_URL_PREFIX).toMatch(/^https:\/\/[^/]+\.invalid\//);
  });

  it("paces the sweep inside the list endpoint's budget", () => {
    // 20 requests a minute; the remainder is headroom for outbound
    // read-backs and the sibling integration on the same token.
    expect(MAX_PAGES_PER_SWEEP).toBeLessThan(20);
    expect(PAGE_SIZE).toBeLessThanOrEqual(100);
  });
});
