import { describe, it, expect } from "vitest";
import {
  MarfaClient,
  getResolvedFields,
  getTypeSchema,
  hydrateTypeRegistry,
  validateProperties,
} from "./index.js";
import type {
  Occurrence,
  OccurrenceSeriesError,
  OccurrencesResult,
  ListOccurrencesOptions,
} from "./index.js";

/**
 * The package root is the only surface a consumer sees, and nothing else
 * in this suite looks at it: every other test imports `./client.js`
 * directly, so a namespace can compile, pass its own tests and still be
 * unreachable through `@withmarfa/sdk`. The compiler does not close that
 * gap either — it catches an export naming something that does not exist,
 * never an export nobody wrote.
 *
 * This file imports from `./index.js` for that reason. It is deliberately
 * a complete list rather than a spot check: adding a namespace fails here
 * until it is exported, which is the moment to notice.
 */

/** Namespaces reachable on a constructed client, in declaration order. */
const NAMESPACES = [
  "items",
  "metadata",
  "edges",
  "blobs",
  "types",
  "keys",
  "webhooks",
  "config",
  "admin",
  "events",
  "occurrences",
] as const;

describe("package entry point", () => {
  it("reaches every namespace through the package root", () => {
    const client = new MarfaClient({
      url: "http://localhost",
      apiKey: "marfa_k1_entry_point",
    });

    for (const name of NAMESPACES) {
      expect(client[name], `client.${name} is missing`).toBeTypeOf("object");
    }

    // The other half of the guard: a namespace added to the client but
    // left off the list above fails here, which is what makes the list a
    // check rather than a copy that quietly falls behind. Namespaces are
    // the object-valued own properties, so the scalar config fields sit
    // outside it; the transport is an implementation detail rather than a
    // surface, and is the one object excluded by name.
    const found = Object.entries(client)
      .filter(
        ([key, value]) => key !== "transport" && typeof value === "object",
      )
      .map(([key]) => key);
    expect(found.sort()).toEqual([...NAMESPACES].sort());
  });

  it("exports the type registry's writer and both of its readers from the package root", () => {
    // One registry instance: the readers have to leave by the same door as
    // the writer, or a consumer resolving two copies of the shared package
    // hydrates one registry and reads the other.
    for (const fn of [
      hydrateTypeRegistry,
      validateProperties,
      getResolvedFields,
      getTypeSchema,
    ]) {
      expect(fn).toBeTypeOf("function");
    }
  });

  it("exports the occurrence types from the package root", () => {
    // Value positions, so these are checked rather than erased: a type
    // missing from `index.ts` fails `tsc --noEmit`, which covers this
    // file along with the rest of `src`.
    const seriesError: OccurrenceSeriesError = {
      item_id: "itm_series",
      message: "unreadable rule",
    };
    const result: OccurrencesResult = {
      data: [],
      next_cursor: null,
      window: {
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-08T00:00:00.000Z",
      },
      scan: {
        events_read: 0,
        occurrences: 0,
        max_occurrences: 5000,
        series_errors: 1,
        max_series_errors: 500,
        unproductive_iterations: 0,
        max_unproductive_iterations: 2_000_000,
        series_unexpanded: 0,
      },
      series_errors: [seriesError],
    };
    const occurrences: Occurrence[] = result.data;
    const options: ListOccurrencesOptions = {
      from: "2026-05-01T00:00:00Z",
      to: "2026-05-08T00:00:00Z",
    };

    expect(occurrences).toEqual([]);
    expect(result.series_errors).toHaveLength(1);
    expect(options.type).toBeUndefined();
  });
});
