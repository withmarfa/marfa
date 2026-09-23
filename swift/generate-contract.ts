/**
 * Write the contract version the Swift types are generated for, read off the
 * document they are generated from, so the two cannot differ.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contractVersionOf } from "../packages/client/scripts/contract-version.js";

const document = JSON.parse(
  readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
) as { info: { version: string } };
const contract = contractVersionOf(document.info.version);
writeFileSync(
  fileURLToPath(new URL("Sources/MarfaTypes/Contract.swift", import.meta.url)),
  `// Generated from openapi.json by swift/generate-contract.ts — do not edit.\n\n/// The contract version these types were generated for: the document's\n/// \`info.version\`, which the instance's root answers as \`contract\`.\npublic let marfaContractVersion = ${String(contract)}\n`,
);
