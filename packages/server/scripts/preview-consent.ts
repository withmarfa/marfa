/**
 * Local visual preview for the consent screen.
 *
 * Renders the screen against several representative scope sets and
 * writes static HTML files to `_local/consent-preview/` with the CSS
 * inlined. Open the files in a browser (or agent-browser) to QA the
 * design without spinning up the full server stack.
 *
 * Descriptions go through the live `buildScopeDescriptions` from
 * `auth-consent.ts` so the preview reflects what users actually see
 * (curated copy first, registry fallback otherwise). Engineering
 * descriptions never leak through.
 *
 * Not committed-runtime code; not exercised by tests.
 *
 *   pnpm --filter @withmarfa/server tsx scripts/preview-consent.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedScope } from "@withmarfa/shared";
import { renderConsentScreen } from "../src/routes/consent.js";
import { buildScopeDescriptions } from "../src/routes/auth-consent.js";
import { AUTH_CSS } from "../src/routes/auth-static/auth-css.js";

const FIXTURES: {
  name: string;
  clientName: string;
  scopes: ParsedScope[];
  priorScopes?: string[];
  errorMessage?: string;
}[] = [
  {
    name: "01-marfa-web-fresh.html",
    clientName: "Marfa · Web",
    scopes: [
      { kind: "oidc", typePattern: "email", oidcScope: "email" } as ParsedScope,
      {
        kind: "oidc",
        typePattern: "offline_access",
        oidcScope: "offline_access",
      } as ParsedScope,
      {
        kind: "oidc",
        typePattern: "openid",
        oidcScope: "openid",
      } as ParsedScope,
      {
        kind: "oidc",
        typePattern: "profile",
        oidcScope: "profile",
      } as ParsedScope,
      { typePattern: "core.bookmark", operation: "read" },
      { typePattern: "core.entity.person", operation: "read" },
      { typePattern: "core.entity.place", operation: "read" },
      { typePattern: "core.entity", operation: "read" },
      { typePattern: "core.event", operation: "read" },
      { typePattern: "core.file.audio", operation: "read" },
      { typePattern: "core.file.image", operation: "read" },
      { typePattern: "core.file.video", operation: "read" },
      { typePattern: "core.file", operation: "read" },
      { typePattern: "core.highlight", operation: "read" },
      { typePattern: "core.note", operation: "read" },
      { typePattern: "core.task", operation: "read" },
      { typePattern: "core.note", operation: "write" },
      { typePattern: "core.task", operation: "write" },
      { typePattern: "core.bookmark", operation: "write" },
      { typePattern: "core.highlight", operation: "write" },
    ],
  },
  {
    name: "02-cli-minimal-fresh.html",
    clientName: "Marfa CLI",
    scopes: [
      {
        kind: "oidc",
        typePattern: "openid",
        oidcScope: "openid",
      } as ParsedScope,
      { typePattern: "core.note", operation: "read" },
      { typePattern: "core.note", operation: "write" },
    ],
  },
  {
    name: "03-marfa-reconsent-diff.html",
    clientName: "Marfa · Web",
    scopes: [
      {
        kind: "oidc",
        typePattern: "openid",
        oidcScope: "openid",
      } as ParsedScope,
      { typePattern: "core.note", operation: "read" },
      { typePattern: "core.note", operation: "write" },
      { typePattern: "core.task", operation: "read" },
      { typePattern: "core.task", operation: "write" },
      { typePattern: "core.bookmark", operation: "read" },
      { typePattern: "core.bookmark", operation: "write" },
    ],
    priorScopes: [
      "openid",
      "core.note:read",
      "core.note:write",
      "core.event:read",
      "core.highlight:read",
    ],
  },
  {
    name: "04-error-banner.html",
    clientName: "Marfa · Web",
    scopes: [
      {
        kind: "oidc",
        typePattern: "openid",
        oidcScope: "openid",
      } as ParsedScope,
      { typePattern: "core.note", operation: "read" },
    ],
    errorMessage: "Approve needs at least one permission ticked.",
  },
];

const outDir = resolve(process.cwd(), "_local/consent-preview");
mkdirSync(outDir, { recursive: true });

const indexLines: string[] = [
  "<!doctype html><meta charset='utf-8'><title>Consent previews</title>",
  "<style>body{font:14px/1.5 -apple-system,sans-serif;padding:32px;max-width:520px;margin:0 auto}",
  "h1{font-weight:600}a{display:block;padding:10px 0;border-bottom:1px solid #eee;text-decoration:none;color:#111}</style>",
  "<h1>Consent screen previews</h1>",
];

for (const fixture of FIXTURES) {
  // Build the descriptions map through the live production code path
  // so curated copy + registry fallbacks are exercised identically.
  // For the diff variant, also pre-build descriptions for the prior
  // scopes' types so removed-rows render their human-readable copy.
  const allScopes: ParsedScope[] = [...fixture.scopes];
  if (fixture.priorScopes) {
    for (const literal of fixture.priorScopes) {
      const lastColon = literal.lastIndexOf(":");
      const typePattern = lastColon > 0 ? literal.slice(0, lastColon) : literal;
      const operationPart = lastColon > 0 ? literal.slice(lastColon + 1) : "";
      const operation: ParsedScope["operation"] =
        operationPart === "write" ? "write" : "read";
      allScopes.push({ typePattern, operation } as ParsedScope);
    }
  }
  const descriptions = buildScopeDescriptions(allScopes);

  const html = renderConsentScreen({
    clientName: fixture.clientName,
    scopes: fixture.scopes,
    clientId: "preview-client",
    oauthQuery: "preview=1",
    descriptions,
    priorScopes: fixture.priorScopes,
    errorMessage: fixture.errorMessage,
  });
  // Replace the external stylesheet link with an inline <style> block
  // so the file works under file:// without a static server.
  const inlined = html.replace(
    /<link rel="stylesheet" href="\/auth\/static\/auth\.css">/,
    `<style>${AUTH_CSS}</style>`,
  );
  writeFileSync(join(outDir, fixture.name), inlined);
  indexLines.push(`<a href='${fixture.name}'>${fixture.name}</a>`);
}

writeFileSync(join(outDir, "index.html"), indexLines.join("\n"));

const indexPath = `file://${join(outDir, "index.html")}`;
console.log(`Wrote ${String(FIXTURES.length)} fixtures to ${outDir}`);
console.log(`Open: ${indexPath}`);
