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
  spacePermission: string;
}[] = [
  {
    file: "items.ts",
    handler: "purgeItemRoute",
    spacePermission: "space.item_purge",
  },
];

interface Site {
  file: string;
  line: number;
  handler: string;
  spacePermission: string | null;
}

/**
 * Anything that begins a route handler.
 *
 * **Not just `openapi(`, and that was a real hole.** Five route files register
 * their surfaces as plain Hono routes and contain no `openapi(` call at all —
 * `auth-pages.ts` alone has twenty-eight. Bounding a handler by `openapi(`
 * there bounded nothing: the window became the whole file, so one
 * `requireSpacePermission` anywhere in it credited every rank-admitting site in it,
 * and every site reported the same `(module scope)` handler. Both effects run
 * in the unsafe direction, and they run in exactly the files the surfaces are
 * hardest to see in by eye.
 */
/**
 * Two shapes, and the argument is what makes them safe to match. A router
 * variable can be called anything — `router`, `r`, `htmlRouter` — so the
 * receiver is not the signal. Matching any `.get(` on any identifier would
 * make `manifests.get(ref)` a handler boundary; requiring a path literal
 * beginning with `/`, or a bare identifier for `openapi`, does not.
 */
const ROUTE_STARTS: readonly RegExp[] = [
  /\b\w+\.openapi\(\s*(\w+)/,
  /\b\w+\.(?:get|post|put|patch|delete|all|on)\(\s*"(\/[^"]*)"/,
];

function routeStart(line: string): string | null {
  for (const re of ROUTE_STARTS) {
    const m = re.exec(line);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** A label for the handler containing `line` — its registered name or path. */
function handlerAbove(lines: readonly string[], line: number): string {
  for (let i = line - 1; i >= 0; i--) {
    const name = routeStart(lines[i] ?? "");
    if (name !== null) return name;
  }
  return "(module scope)";
}

/**
 * The capability consulted inside the same handler, if any.
 *
 * Bounded by the next route registration rather than by brace matching: the
 * handlers are long, several carry nested closures, and a brace counter that
 * loses its place would report an absence rather than fail, which is the
 * direction that costs something.
 */
function spacePermissionWithin(
  lines: readonly string[],
  line: number,
): string | null {
  let start = 0;
  for (let i = line - 1; i >= 0; i--) {
    if (routeStart(lines[i] ?? "") !== null) {
      start = i;
      break;
    }
  }
  let end = lines.length;
  for (let i = line; i < lines.length; i++) {
    if (routeStart(lines[i] ?? "") !== null) {
      end = i;
      break;
    }
  }
  for (let i = start; i < end; i++) {
    const direct = /requireSpacePermission\(\s*c\s*,\s*"([^"]+)"/.exec(
      lines[i] ?? "",
    );
    if (direct) return direct[1] ?? null;
    // `resolveSpaceAdminCaller` takes its capability as a required argument
    // rather than calling `requireSpacePermission` at the site, so that a new
    // surface behind it cannot be added without answering the question. The
    // literal is on its own line among the arguments.
    const viaResolver = /^\s*"(space\.[a-z_]+)",\s*$/.exec(lines[i] ?? "");
    if (viaResolver) return viaResolver[1] ?? null;
  }
  return null;
}

function census(): Site[] {
  const out: Site[] = [];
  for (const file of readdirSync(ROUTES_DIR).sort()) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const lines = readFileSync(join(ROUTES_DIR, file), "utf8").split("\n");
    lines.forEach((text, i) => {
      // Comments mention these names; a line that is only a comment is not a
      // door, and treating one as ungated would redden the suite for prose.
      const code = text.trim();
      if (code.startsWith("//") || code.startsWith("*")) return;
      // The open paren rather than `(c)`, so a call Prettier has wrapped onto
      // the next line is still seen. The identifier and its paren stay
      // together; the argument does not.
      const admitsOnRank =
        text.includes("requireSpaceAdmin(") ||
        text.includes("hasSpaceAdminAuthority(") ||
        // Admits on rank one level down, and everything it admits is a
        // surface. Its own capability argument is what this counts.
        text.includes("resolveSpaceAdminCaller(");
      if (!admitsOnRank) return;
      out.push({
        file,
        line: i + 1,
        handler: handlerAbove(lines, i + 1),
        spacePermission: spacePermissionWithin(lines, i + 1),
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
      .filter((s) => s.spacePermission === null)
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
      for (const s of match) expect(s.spacePermission).toBeNull();
    }
  });

  it("sees every file that admits through the shared resolver", () => {
    // **The scanner going blind is the failure this catches.** Sites reached
    // through `resolveSpaceAdminCaller` contain none of the strings the other
    // rules grep for, so before it was taught to look for the resolver they
    // were absent from the census entirely — not gated, not ungated, not
    // anything. Five doors sat in that gap, one of them the `GET` twin of a
    // door gated in this same change. An absence reads as a clean sweep, so it
    // has to be asserted against the tree rather than trusted.
    const viaResolver = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) =>
        readFileSync(join(ROUTES_DIR, f), "utf8").includes(
          "resolveSpaceAdminCaller(",
        ),
      )
      .filter((f) => f !== "_space-caller.ts");
    expect(viaResolver.length).toBeGreaterThan(0);
    for (const file of viaResolver) {
      expect(
        sites.some((s) => s.file === file && s.spacePermission !== null),
        `${file} admits through the resolver but the census sees no gated door in it`,
      ).toBe(true);
    }
  });

  it("keeps both exemptions real, so a stale one is noticed", () => {
    // An exemption for a handler that no longer exists, or that has since been
    // gated, is a license nobody is using and the next reader would trust.
    for (const e of EXEMPT) {
      const match = sites.filter(
        (s) => s.file === e.file && s.handler === e.handler,
      );
      expect(match.length, `${e.file}:${e.handler} — ${e.why}`).toBeGreaterThan(
        0,
      );
      for (const s of match) expect(s.spacePermission).toBeNull();
    }
  });

  it("asks each door for the capability its own surface names", () => {
    // The mapping, so a door gated on the wrong literal is caught. A file may
    // name more than one where it carries more than one surface.
    const expected: Record<string, readonly string[]> = {
      "audit.ts": ["space.audit_read"],
      "auth-pages.ts": ["space.app_grants"],
      "connection-leased-tokens.ts": ["space.connections"],
      "connection-mapping.ts": ["space.connections"],
      "connection-configure.ts": ["space.connections"],
      "connection-proxy.ts": ["space.upstream_access"],
      "connections.ts": ["space.connections"],
      "credentials.ts": ["space.credentials"],
      "edge-types.ts": ["space.schema"],
      "inbound-webhooks.ts": ["space.connections"],
      "integrations.ts": ["space.connections"],
      "items.ts": ["space.item_purge"],
      "keys.ts": ["space.keys"],
      "oauth-callback.ts": ["space.credentials"],
      "spaces.ts": ["space.settings", "space.usage"],
      "types.ts": ["space.schema"],
      "webhooks.ts": ["space.webhooks"],
    };
    const wrong = sites
      .filter((s) => s.spacePermission !== null)
      .filter(
        (s) => !(expected[s.file] ?? []).includes(s.spacePermission ?? ""),
      )
      .map(
        (s) =>
          `${s.file}:${String(s.line)} ${s.handler} -> ${s.spacePermission ?? "none"}`,
      );
    expect(wrong).toEqual([]);
  });
});
