/**
 * The webhook event vocabulary reaches the published specification.
 *
 * `events` was `z.array(z.string())` in the schema and a closed set in the
 * handler, so the constraint was real, enforced and invisible: a generated
 * client got `string`, an editor offered no completion, and the only way to
 * learn a valid name was to send a wrong one and read the 400. A
 * specification accepting any string where the runtime accepts ten is wrong
 * rather than incomplete — it positively asserts that anything is fine.
 *
 * **What this pins is the derivation, not the list.** Restating the members
 * here would reintroduce exactly the drift the change removed: the test and
 * the spec would then agree with each other while both disagreed with the
 * runtime. So it asserts that what the specification carries IS
 * `WEBHOOK_EVENTS`, which is why removing an event from that array changes
 * the generated document.
 */
import { describe, expect, it } from "vitest";
import { buildPublishedOpenAPISpec } from "../openapi-published.js";
import { WEBHOOK_EVENTS } from "./webhooks.js";

interface SchemaNode {
  enum?: unknown;
  items?: SchemaNode;
  properties?: Record<string, SchemaNode>;
  requestBody?: {
    content?: Record<string, { schema?: SchemaNode }>;
  };
}

function eventsEnumAt(
  spec: Record<string, unknown>,
  path: string,
  method: string,
): unknown {
  const paths = spec.paths as Record<string, Record<string, SchemaNode>>;
  const operation = paths[path]?.[method];
  const schema = operation?.requestBody?.content?.["application/json"]?.schema;
  return schema?.properties?.events?.items?.enum;
}

describe("the webhook event vocabulary is published", () => {
  it("offers every event the runtime accepts, on both doors that take one", async () => {
    const spec = await buildPublishedOpenAPISpec();

    // Both request doors, because a caller subscribing and a caller
    // editing a subscription need the same list and one of them was
    // easy to miss.
    for (const [path, method] of [
      ["/webhooks", "post"],
      ["/webhooks/{id}", "patch"],
    ] as const) {
      const carried = eventsEnumAt(spec, path, method);
      expect(
        carried,
        `${method.toUpperCase()} ${path} publishes no event vocabulary, so a ` +
          `client generated from this spec still gets a bare string`,
      ).toEqual([...WEBHOOK_EVENTS]);
    }
  });

  it("is a vocabulary rather than an empty array", async () => {
    // A derivation that resolved to nothing would satisfy the assertion
    // above against an empty source and publish an enum nobody can use.
    const spec = await buildPublishedOpenAPISpec();
    const carried = eventsEnumAt(spec, "/webhooks", "post") as string[];
    expect(carried.length).toBeGreaterThan(1);
    // Every published name is one dispatch can match. `*` was published and
    // matched nothing, so a caller who read it off this enum registered a
    // subscription that could never fire; it is named here so re-offering it
    // has to be a decision rather than an edit to an array.
    expect(carried).not.toContain("*");
  });
});
