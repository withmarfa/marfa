/**
 * Write the contract version this client is generated for, read off the
 * document it is generated from, so the two cannot differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const document = JSON.parse(
  readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"),
) as { info: { version: string } };
// Digits with no leading zero: `1.0` or `01` would read as 1 and hide a
// document that no longer states the contract the way the root answers it.
if (!/^[1-9][0-9]*$/.test(document.info.version)) {
  throw new Error(
    `openapi.json's info.version is "${document.info.version}", not a contract version`,
  );
}
writeFileSync(
  fileURLToPath(new URL("../src/contract.ts", import.meta.url)),
  `// Generated from openapi.json by scripts/generate-contract.ts — do not edit.\n\n/** The contract version this client was generated for. */\nexport const CONTRACT_VERSION = ${document.info.version};\n`,
);
