/**
 * Local visual preview for the consent screen.
 *
 * Renders the screen against several representative scope sets and
 * writes static HTML files to `_local/consent-preview/` with the CSS
 * inlined. Open the files in a browser (or agent-browser) to QA the
 * design without spinning up the full server stack.
 *
 * Not committed-runtime code; not exercised by tests.
 *
 *   pnpm --filter @mymehq/server tsx scripts/preview-consent.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ParsedScope } from "@mymehq/shared";
import { renderConsentScreen } from "../src/routes/consent.js";
import { AUTH_CSS } from "../src/routes/auth-static/auth-css.js";

const FIXTURES: {
  name: string;
  clientName: string;
  scopes: ParsedScope[];
  descriptions: Record<string, string>;
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
    descriptions: {
      email: "See your email address.",
      offline_access: "Stay signed in even when you're not using the app.",
      openid: "Confirm your identity.",
      profile: "See your name and profile picture.",
      "core.bookmark":
        "Content you captured from elsewhere — a saved URL, a highlight, an excerpt, a clipped paragraph.",
      "core.entity.person":
        "Contact information for an individual. Inherits all core.entity fields.",
      "core.entity.place":
        "A location or venue. Inherits all core.entity fields.",
      "core.entity":
        "A non-person entity — a company, band, team, charity, brand, school.",
      "core.event": "Something that happens at a time.",
      "core.file.audio":
        "Recordings, music files, voice memos. Inherits all core.file fields.",
      "core.file.image":
        "Photos, screenshots, diagrams. Inherits all core.file fields.",
      "core.file.video": "Video files. Inherits all core.file fields.",
      "core.file":
        "A file or binary reference — the generic fallback for non-media files.",
      "core.highlight":
        "A user's engagement with content — the highlighted passage plus optional annotation.",
      "core.note": "Text content you created.",
      "core.task": "Tasks and todos.",
    },
  },
  {
    name: "02-cli-minimal-fresh.html",
    clientName: "Myme CLI",
    scopes: [
      {
        kind: "oidc",
        typePattern: "openid",
        oidcScope: "openid",
      } as ParsedScope,
      { typePattern: "core.note", operation: "read" },
      { typePattern: "core.note", operation: "write" },
    ],
    descriptions: {
      openid: "Confirm your identity.",
      "core.note": "Text content you created.",
    },
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
    descriptions: {
      openid: "Confirm your identity.",
      "core.note": "Text content you created.",
      "core.task": "Tasks and todos.",
      "core.bookmark":
        "Content you captured from elsewhere — a saved URL, a highlight, an excerpt, a clipped paragraph.",
      "core.event": "Something that happens at a time.",
      "core.highlight":
        "A user's engagement with content — the highlighted passage plus optional annotation.",
    },
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
    descriptions: {
      openid: "Confirm your identity.",
      "core.note": "Text content you created.",
    },
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
  const html = renderConsentScreen({
    clientName: fixture.clientName,
    scopes: fixture.scopes,
    clientId: "preview-client",
    oauthQuery: "preview=1",
    descriptions: fixture.descriptions,
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
