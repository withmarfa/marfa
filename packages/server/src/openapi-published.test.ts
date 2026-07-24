import { beforeAll, describe, expect, it } from "vitest";
import {
  AUTH_MODES,
  buildPublishedOpenAPISpec,
  buildSpecForAuthMode,
} from "./openapi-published.js";

type Operation = Record<string, unknown>;
type Paths = Record<string, Record<string, Operation>>;

/** `GET /items/{id}` — the identity used to compare operations across specs. */
function operationKeys(spec: Record<string, unknown>): Map<string, Operation> {
  const paths = (spec.paths ?? {}) as Paths;
  const out = new Map<string, Operation>();
  for (const [path, methods] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      out.set(`${method.toUpperCase()} ${path}`, operation);
    }
  }
  return out;
}

describe("published OpenAPI spec", () => {
  let published: Map<string, Operation>;
  /** Operation key -> the auth modes whose app actually mounts it. */
  let servedBy: Map<string, string[]>;

  beforeAll(async () => {
    published = operationKeys(await buildPublishedOpenAPISpec());

    servedBy = new Map();
    for (const mode of AUTH_MODES) {
      for (const key of operationKeys(
        await buildSpecForAuthMode(mode),
      ).keys()) {
        servedBy.set(key, [...(servedBy.get(key) ?? []), mode]);
      }
    }
  }, 60_000);

  it("covers every operation mounted in any auth mode", () => {
    const missing = [...servedBy.keys()]
      .filter((key) => !published.has(key))
      .sort();
    expect(
      missing,
      `Operations mounted by the server but absent from the published spec:\n${missing
        .map(
          (key) =>
            `  ${key} (served in ${(servedBy.get(key) ?? []).join(", ")} mode)`,
        )
        .join("\n")}`,
    ).toEqual([]);
  });

  it("marks each mode-exclusive operation with the modes that serve it", () => {
    const exclusive = [...servedBy.entries()].filter(
      ([, modes]) => modes.length < AUTH_MODES.length,
    );

    for (const [key, modes] of exclusive) {
      const operation = published.get(key);
      expect(
        operation,
        `${key} is missing from the published spec`,
      ).toBeDefined();
      expect(
        operation?.["x-marfa-auth-modes"],
        `${key} auth-mode marker`,
      ).toEqual(modes);
      expect(String(operation?.description), `${key} description`).toContain(
        "AUTH_MODE",
      );
    }
  });

  it("gives every published operation an operationId", () => {
    // The internal-operation exclusion in `openapi-finalize.ts` keys on
    // operationId, so an operation without one can never be filtered out, and
    // reference renderers fall back to generating an unstable anchor for it.
    const anonymous = [...published.entries()]
      .filter(([, operation]) => typeof operation.operationId !== "string")
      .map(([key]) => key)
      .sort();
    expect(anonymous).toEqual([]);
  });

  it("leaves operations served in every mode unmarked", () => {
    const universal = [...servedBy.entries()].filter(
      ([, modes]) => modes.length === AUTH_MODES.length,
    );

    // Guards against the marker degenerating into noise stamped on everything.
    expect(universal.length).toBeGreaterThan(0);
    for (const [key] of universal) {
      expect(
        published.get(key)?.["x-marfa-auth-modes"],
        `${key} should carry no auth-mode marker`,
      ).toBeUndefined();
    }
  });
});
