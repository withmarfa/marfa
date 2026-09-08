/**
 * Every space-admin door, and the capability it consults.
 *
 * **A census rather than a per-route test, for the reason the credential-mint
 * census exists.** A gate added to nine doors and forgotten on the tenth reads
 * as covered from every angle a per-route test can see: each route that was
 * changed has a passing test, and the one that was not has no failing one. The
 * property worth asserting is the shape of the whole surface, so that adding a
 * `requireSpaceAdmin` without a capability beside it is what turns something
 * red.
 *
 * The rule: a handler that admits a caller on space-admin rank is reachable by
 * an OAuth bearer, because the bearer middleware projects the signed-in user's
 * role onto the synthetic principal. So rank alone would let an app act with
 * authority nobody consented to, and every such handler must also ask which
 * capability was granted.
 *
 * Two exemptions, both recorded at their own call sites and in
 * `packages/shared/src/scopes.ts`. They are named here rather than detected,
 * so that removing the reasoning at the site does not quietly remove the
 * exemption too.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = join(import.meta.dirname, ".");

/**
 * Sites that admit on rank and deliberately consult no capability.
 *
 * `listEdgeTypesRoute` — listing a space's edge types is a read whose
 * item-type sibling is open to any authenticated caller. The consistent answer
 * is relaxing that rank gate rather than putting a capability in front of a
 * listing, and until it is relaxed it is inconsistent in the safe direction.
 *
 * `_space-caller.ts` — the caller resolver answers *which space* a request
 * acts in, ahead of the surfaces that are surfaces. Gating it would gate the
 * question rather than an answer.
 */
const EXEMPT: readonly { file: string; handler: string; why: string }[] = [
  {
    file: "edge-types.ts",
    handler: "listEdgeTypesRoute",
    why: "a listing whose item-type sibling is open; the rank gate is what should relax",
  },
  {
    file: "_space-caller.ts",
    handler: "(module scope)",
    why: "resolves which space, ahead of the surfaces",
  },
];

/**
 * Doors whose capability is written and whose enforcement is waiting on a
 * client, listed separately from {@link EXEMPT} because the two mean opposite
 * things: an exemption is a door that should never consult a capability, and a
 * deferral is one that will, shortly, and whose entry here is meant to be
 * deleted.
 *
 * `purgeItemRoute` — Marfa Mini's Empty Bin calls this door, and Mini gained
 * both the scope and any way to notice a short grant only in 0.8.1. Gating it
 * before that release is installed and signed into would break the command
 * with no path back short of a sign-out, so it lands as its own merge when
 * that is confirmed. T-357 does not close until it does.
 */
const DEFERRED: readonly {
  file: string;
  handler: string;
  capability: string;
}[] = [
  {
    file: "items.ts",
    handler: "purgeItemRoute",
    capability: "capability.item_purge",
  },
];

interface Site {
  file: string;
  line: number;
  handler: string;
  capability: string | null;
}

/** The nearest `router.openapi(<name>` above `line`, or module scope. */
function handlerAbove(lines: readonly string[], line: number): string {
  for (let i = line - 1; i >= 0; i--) {
    const m = /\b(?:router|r)\.openapi\((\w+)/.exec(lines[i] ?? "");
    if (m) return m[1] ?? "(module scope)";
  }
  return "(module scope)";
}

/**
 * The capability consulted inside the same handler, if any.
 *
 * Bounded by the next `openapi(` registration rather than by brace matching:
 * the handlers are long, several carry nested closures, and a brace counter
 * that loses its place would report an absence rather than fail, which is the
 * direction that costs something.
 */
function capabilityWithin(
  lines: readonly string[],
  line: number,
): string | null {
  let start = 0;
  for (let i = line - 1; i >= 0; i--) {
    if (/\b(?:router|r)\.openapi\(/.test(lines[i] ?? "")) {
      start = i;
      break;
    }
  }
  let end = lines.length;
  for (let i = line; i < lines.length; i++) {
    if (/\b(?:router|r)\.openapi\(/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  for (let i = start; i < end; i++) {
    const m = /requireCapability\(\s*c\s*,\s*"([^"]+)"/.exec(lines[i] ?? "");
    if (m) return m[1] ?? null;
  }
  return null;
}

function census(): Site[] {
  const out: Site[] = [];
  for (const file of readdirSync(ROUTES_DIR).sort()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const lines = readFileSync(join(ROUTES_DIR, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      const admitsOnRank =
        text.includes("requireSpaceAdmin(c)") ||
        text.includes("hasSpaceAdminAuthority(");
      if (!admitsOnRank) return;
      out.push({
        file,
        line: i + 1,
        handler: handlerAbove(lines, i + 1),
        capability: capabilityWithin(lines, i + 1),
      });
    });
  }
  return out;
}

describe("every space-admin door consults a capability", () => {
  const sites = census();

  it("finds the surface at all, so an empty census cannot pass", () => {
    // A scanner that stops matching reports a clean sweep. This is what makes
    // the assertion below mean something.
    expect(sites.length).toBeGreaterThan(30);
  });

  it("leaves no door admitting on rank alone", () => {
    const excused = new Set(
      [...EXEMPT, ...DEFERRED].map((e) => `${e.file}:${e.handler}`),
    );
    const ungated = sites
      .filter((s) => s.capability === null)
      .filter((s) => !excused.has(`${s.file}:${s.handler}`))
      .map((s) => `${s.file}:${String(s.line)} ${s.handler}`);
    expect(ungated).toEqual([]);
  });

  it("defers exactly one door, and it is the one waiting on a client", () => {
    // The deferral is narrow on purpose. Widening this list is how a phase
    // that shipped most of a rule comes to look finished, so the set is
    // asserted rather than merely consulted, and a second entry appearing
    // without a decision behind it turns this red.
    expect(DEFERRED.map((d) => `${d.file}:${d.handler}`)).toEqual([
      "items.ts:purgeItemRoute",
    ]);
    for (const d of DEFERRED) {
      const match = sites.filter(
        (s) => s.file === d.file && s.handler === d.handler,
      );
      expect(match.length).toBeGreaterThan(0);
      // Still ungated. When the follow-on merge lands, this reddens and the
      // entry is deleted — which is the point of listing it here at all.
      for (const s of match) expect(s.capability).toBeNull();
    }
  });

  it("keeps both exemptions real, so a stale one is noticed", () => {
    // An exemption for a handler that no longer exists, or that has since been
    // gated, is a licence nobody is using and the next reader would trust.
    for (const e of EXEMPT) {
      const match = sites.filter(
        (s) => s.file === e.file && s.handler === e.handler,
      );
      expect(match.length, `${e.file}:${e.handler} — ${e.why}`).toBeGreaterThan(
        0,
      );
      for (const s of match) expect(s.capability).toBeNull();
    }
  });

  it("asks each door for the capability its own surface names", () => {
    // The mapping, so a door gated on the wrong literal is caught. A file may
    // name more than one where it carries more than one surface.
    const expected: Record<string, readonly string[]> = {
      "audit.ts": ["capability.audit_read"],
      "auth-pages.ts": ["capability.app_grants"],
      "connection-leased-tokens.ts": ["capability.connections"],
      "connection-mapping.ts": ["capability.connections"],
      "connection-proxy.ts": ["capability.upstream_access"],
      "connections.ts": ["capability.connections"],
      "credentials.ts": ["capability.credentials"],
      "edge-types.ts": ["capability.schema"],
      "inbound-webhooks.ts": ["capability.connections"],
      "items.ts": ["capability.item_purge"],
      "keys.ts": ["capability.keys"],
      "oauth-callback.ts": ["capability.credentials"],
      "spaces.ts": ["capability.space_settings", "capability.space_usage"],
      "types.ts": ["capability.schema"],
      "webhooks.ts": ["capability.webhooks"],
    };
    const wrong = sites
      .filter((s) => s.capability !== null)
      .filter((s) => !(expected[s.file] ?? []).includes(s.capability ?? ""))
      .map(
        (s) =>
          `${s.file}:${String(s.line)} ${s.handler} -> ${s.capability ?? "none"}`,
      );
    expect(wrong).toEqual([]);
  });
});
