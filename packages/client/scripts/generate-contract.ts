/**
 * Write the contract version this client is generated for, read off the
 * document it is generated from, so the two cannot differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractVersionOf } from "./contract-version.js";

const document = JSON.parse(
  readFileSync(new URL("../../../openapi.json", import.meta.url), "utf8"),
) as { info: { version: string } };
const contract = contractVersionOf(document.info.version);
writeFileSync(
  fileURLToPath(new URL("../src/generated/contract.ts", import.meta.url)),
  `// Generated from openapi.json by scripts/generate-contract.ts — do not edit.\n\n/** The contract version this client was generated for. */\nexport const CONTRACT_VERSION = ${String(contract)};\n`,
);
