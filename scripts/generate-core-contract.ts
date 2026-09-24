/**
 * Write the contract version the core is built for, read off the document
 * the server is described by, so the two cannot differ. The core keeps its
 * own transport rather than the generated crate, so it takes the number
 * here rather than from that crate.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractVersionOf } from "../packages/client/scripts/contract-version.js";

const document = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
) as { info: { version: string } };
const contract = contractVersionOf(document.info.version);
writeFileSync(
  fileURLToPath(new URL("../core/marfa-core/src/contract.rs", import.meta.url)),
  `// Generated from openapi.json by scripts/generate-core-contract.ts — do not edit.\n\n/// The contract version this core was built for: the document's\n/// \`info.version\`, which every answer names in \`X-Marfa-Contract\`.\npub const CONTRACT_VERSION: u64 = ${String(contract)};\n`,
);
