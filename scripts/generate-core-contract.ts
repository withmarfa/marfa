/**
 * Write the contract version the core is built for, and the operations the
 * server answers again by `Idempotency-Key`, read off the document the
 * server is described by, so the two cannot differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractVersionOf } from "../packages/client/scripts/contract-version.js";
import { keyedWrites } from "./keyed-writes.js";

const document = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
) as Parameters<typeof keyedWrites>[0] & { info: { version: string } };
const contract = contractVersionOf(document.info.version);
const keyed = keyedWrites(document)
  .map(([method, path]) => `    ("${method}", "${path}"),\n`)
  .join("");
writeFileSync(
  fileURLToPath(new URL("../core/marfa-core/src/contract.rs", import.meta.url)),
  `// Generated from openapi.json by scripts/generate-core-contract.ts — do not edit.\n\n/// The contract version this core was built for: the document's\n/// \`info.version\`, which every answer names in \`X-Marfa-Contract\`.\npub const CONTRACT_VERSION: u64 = ${String(contract)};\n\n/// The operations that take an \`Idempotency-Key\`, as method and path\n/// template: the server answers a write sent again under its key from its\n/// record of the first.\npub const KEYED_WRITES: &[(&str, &str)] = &[\n${keyed}];\n`,
);
