// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decodeFilter, encodeFilter, filterOperators } from "../index.js";

// The cases the server's parser and the core's model are both held to.
const SHARED = JSON.parse(
  readFileSync(
    new URL("../../../../conformance/fixtures/filter-expressions.json", import.meta.url),
    "utf8",
  ),
);

test("encodes and decodes every shared case in the fixture's JSON form", () => {
  for (const { description, text, expression } of SHARED.canonical) {
    assert.equal(encodeFilter(expression), text, description);
    assert.deepEqual(decodeFilter(text), expression, description);
  }
  for (const { description, text, canonical } of SHARED.variants) {
    assert.equal(encodeFilter(decodeFilter(text)), canonical, description);
  }
});

test("throws the server's code and message", () => {
  for (const { description, text, code, message } of SHARED.refused) {
    assert.throws(
      () => decodeFilter(text),
      { code: "validation", serverCode: code, message: `validation: (${code}) ${message}` },
      description,
    );
  }
  assert.throws(
    () =>
      encodeFilter({
        join: "all",
        conditions: [{ field: { kind: "property", name: "a" }, operator: "eq", value: "ends in \\" }],
      }),
    { serverCode: "validation_error", message: /cannot end in a backslash/ },
  );
});

test("refuses a value that is not a model rather than guessing", () => {
  assert.throws(
    () =>
      encodeFilter(
        /** @type {any} */ ({ join: "both", conditions: [] }),
      ),
    /not a filter model/,
  );
});

test("offers the operators each field takes", () => {
  assert.deepEqual(filterOperators({ kind: "member", field: "emails", member: "address" }), ["eq"]);
  assert.deepEqual(filterOperators({ kind: "tags" }), ["contains", "exists", "not_exists"]);
});
