/**
 * The permission diff that decides whether an upgrade needs consent.
 *
 * The property under test throughout: widening is detected, narrowing is
 * not reported. Getting the first wrong grants something nobody approved;
 * getting the second wrong puts a consent screen in front of a move that
 * takes less than the connection already has.
 */
import { describe, it, expect } from "vitest";
import type { IntegrationManifest } from "@withmarfa/shared";
import { diffManifestGrants, describeGrantDelta } from "./manifest-diff.js";

function manifest(
  over: Partial<IntegrationManifest> = {},
): IntegrationManifest {
  return {
    name: "acme/thing",
    version: "1.0.0",
    manifest_schema_version: "2.0.0",
    publisher: "acme",
    description: "diff test",
    direction: "read",
    runs_on: "server" as const,
    triggers: [{ type: "schedule", config: { cron: "0 * * * *" } }],
    target_types: ["core.note"],
    bidirectional_handling: {
      echo_ttl_seconds: 60,
      lag_window_seconds: 60,
      tombstone_mapping: "ignore",
      partial_write_mode: "accept-partial",
    },
    oauth_requirements: {},
    webhook_verification: { method: "hmac-sha256" },
    ...over,
  };
}

describe("diffManifestGrants", () => {
  it("reports no widening for an identical manifest", () => {
    const d = diffManifestGrants(manifest(), manifest());
    expect(d.widens).toBe(false);
  });

  it("catches a new target type", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({ target_types: ["core.note", "core.bookmark"] }),
    );
    expect(d.widens).toBe(true);
    expect(d.types).toEqual([{ name: "core.bookmark", to: "write" }]);
  });

  it("treats a removed target type as narrowing, not widening", () => {
    const d = diffManifestGrants(
      manifest({ target_types: ["core.note", "core.bookmark"] }),
      manifest({ target_types: ["core.note"] }),
    );
    expect(d.widens).toBe(false);
    expect(d.types).toEqual([]);
  });

  it("catches an extension permission that appears", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({ permissions: { extension: { "acme.thing": "write" } } }),
    );
    expect(d.widens).toBe(true);
    expect(d.extensions).toEqual([{ name: "acme.thing", to: "write" }]);
  });

  it("catches an extension escalating from read to write", () => {
    const d = diffManifestGrants(
      manifest({ permissions: { extension: { "acme.thing": "read" } } }),
      manifest({ permissions: { extension: { "acme.thing": "write" } } }),
    );
    expect(d.widens).toBe(true);
    expect(d.extensions).toEqual([
      { name: "acme.thing", from: "read", to: "write" },
    ]);
  });

  it("does not report an extension dropping from write to read", () => {
    const d = diffManifestGrants(
      manifest({ permissions: { extension: { "acme.thing": "write" } } }),
      manifest({ permissions: { extension: { "acme.thing": "read" } } }),
    );
    expect(d.widens).toBe(false);
  });

  it("catches a new edge permission", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({ permissions: { edge: { "in-collection": "write" } } }),
    );
    expect(d.widens).toBe(true);
    expect(d.edges).toEqual([{ name: "in-collection", to: "write" }]);
  });

  it("catches a new credential requirement", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({ oauth_requirements: { acme: "proxy" } }),
    );
    expect(d.widens).toBe(true);
    expect(d.oauth).toEqual([{ name: "acme", to: "proxy" }]);
  });

  it("catches a credential requirement changing mode", () => {
    const d = diffManifestGrants(
      manifest({ oauth_requirements: { acme: "proxy" } }),
      manifest({ oauth_requirements: { acme: "leased" } }),
    );
    expect(d.widens).toBe(true);
    expect(d.oauth).toEqual([{ name: "acme", from: "proxy", to: "leased" }]);
  });

  it("catches a new API token requirement", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({ token_requirements: { acme: "required" } }),
    );
    expect(d.widens).toBe(true);
    expect(d.tokens).toEqual([{ name: "acme", to: "required" }]);
  });

  it("catches a configuration field that becomes required", () => {
    const d = diffManifestGrants(
      manifest({
        configuration_schema: {
          feed_url: { type: "string", description: "x" },
        },
      }),
      manifest({
        configuration_schema: {
          feed_url: { type: "string", description: "x", required: true },
        },
      }),
    );
    expect(d.widens).toBe(true);
    expect(d.configurationRequired).toEqual(["feed_url"]);
  });

  it("does not report a required field becoming optional", () => {
    const d = diffManifestGrants(
      manifest({
        configuration_schema: {
          feed_url: { type: "string", description: "x", required: true },
        },
      }),
      manifest({
        configuration_schema: {
          feed_url: { type: "string", description: "x" },
        },
      }),
    );
    expect(d.widens).toBe(false);
  });

  it("cancels out the connection's own mapping, which the user consented to separately", () => {
    // A stored mapping contributes target types to the projection on both
    // sides. It is the user's own choice, not something the new manifest
    // is asking for, so it must not read as widening.
    const connectionProperties = {
      mapping: {
        version: 1,
        rules: [
          {
            when: { path: "kind", op: "exists" },
            target_type: "jonah.reading_item",
            assign: { headline: { path: "title" } },
          },
        ],
        otherwise: "family",
      },
    };
    const d = diffManifestGrants(
      manifest(),
      manifest({ version: "2.0.0" }),
      connectionProperties,
    );
    expect(d.widens).toBe(false);
  });

  it("says what is new in words a person can act on", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({
        target_types: ["core.note", "core.bookmark"],
        oauth_requirements: { acme: "proxy" },
      }),
    );
    expect(describeGrantDelta(d)).toEqual([
      "Writes a new kind of item: core.bookmark",
      "Needs access to a new service: acme",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Triggers and capability declarations, ruled non-widening.
//
// These cases pass on the code as it stands, and that is the point: the
// answer was a fallthrough rather than a decision, because `triggers`
// appears nowhere in the diff at all. Pinning it makes the ruling
// deliberate, and makes any later attempt to fold triggers into the
// permission model fail here rather than silently start demanding consent
// for a change that grants nothing.
//
// The rule: a trigger changes *when* an integration runs, not what it can
// reach. Reach is target types, the permission maps and the auth
// requirements, and those already gate.
// ---------------------------------------------------------------------------

describe("diffManifestGrants — triggers grant nothing", () => {
  it("adding a manual trigger does not widen", () => {
    // The case that proves the rule: `manual` lets a person ask for the
    // sweep the schedule already performs. It reaches nothing new.
    const d = diffManifestGrants(
      manifest(),
      manifest({
        triggers: [
          { type: "schedule", config: { cron: "0 * * * *" } },
          { type: "manual" },
        ],
      }),
    );
    expect(d.widens).toBe(false);
    expect(describeGrantDelta(d)).toEqual([]);
  });

  it("adding a webhook trigger does not widen", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({
        triggers: [
          { type: "schedule", config: { cron: "0 * * * *" } },
          { type: "webhook" },
        ],
      }),
    );
    expect(d.widens).toBe(false);
  });

  it("changing the schedule does not widen", () => {
    const d = diffManifestGrants(
      manifest(),
      manifest({
        triggers: [{ type: "schedule", config: { cron: "*/5 * * * *" } }],
      }),
    );
    expect(d.widens).toBe(false);
  });

  it("declaring support for user mappings does not widen", () => {
    // A capability declaration, not a grant. It says the integration can
    // honor a mapping the user writes; it takes nothing.
    const d = diffManifestGrants(
      manifest(),
      manifest({ supports_user_mappings: true }),
    );
    expect(d.widens).toBe(false);
  });

  it("a trigger addition alongside a real widening still widens, on the widening", () => {
    // Guards the inverse mistake: treating triggers as inert must not make
    // the rest of the diff inert on the same manifest.
    const d = diffManifestGrants(
      manifest(),
      manifest({
        triggers: [
          { type: "schedule", config: { cron: "0 * * * *" } },
          { type: "manual" },
        ],
        target_types: ["core.note", "core.bookmark"],
      }),
    );
    expect(d.widens).toBe(true);
    expect(d.types).toEqual([{ name: "core.bookmark", to: "write" }]);
  });
});
