/**
 * Write the client's types from the document, and the media type each door
 * that takes raw bytes declares for them.
 *
 * openapi-typescript types a `format: binary` schema as `string`, which is
 * what a caller would then send, and a string is not bytes. A request body
 * of that format is typed as the bytes `fetch` sends as they are instead, so
 * no caller needs a cast to upload. An answer of that format keeps the
 * generator's type: what it reads as comes from the call's `parseAs`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import ts from "typescript";

const source = new URL("../../../openapi.json", import.meta.url);
const generated = (name: string) =>
  fileURLToPath(new URL(`../src/generated/${name}`, import.meta.url));

const BYTES = ts.factory.createUnionTypeNode(
  ["Blob", "ArrayBuffer", "ArrayBufferView", "ReadableStream<Uint8Array>"].map(
    (name) => ts.factory.createTypeReferenceNode(name),
  ),
);

// CI empties the folder before generating into it, to catch a file no
// generator writes.
mkdirSync(fileURLToPath(new URL("../src/generated/", import.meta.url)), {
  recursive: true,
});

const ast = await openapiTS(source, {
  transform(schema, { path }) {
    if (schema.format === "binary" && path?.includes("/requestBody/")) {
      return BYTES;
    }
    return undefined;
  },
});
writeFileSync(generated("schema.ts"), `${COMMENT_HEADER}${astToString(ast)}`);

interface Operation {
  requestBody?: {
    content?: Record<string, { schema?: { format?: string } }>;
  };
}
const document = JSON.parse(readFileSync(source, "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
};
const declared: Record<string, string> = {};
for (const [path, operations] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    const content = operation.requestBody?.content ?? {};
    const binary = Object.entries(content).find(
      ([, media]) => media.schema?.format === "binary",
    );
    if (binary) declared[`${method.toUpperCase()} ${path}`] = binary[0];
  }
}
writeFileSync(
  generated("byte-bodies.ts"),
  `// Generated from openapi.json by scripts/generate-schema.ts — do not edit.\n\n/** The media type each door that takes raw bytes declares, by method and path. */\nexport const BYTE_BODIES: Readonly<Record<string, string>> = ${JSON.stringify(declared, null, 2)};\n`,
);
