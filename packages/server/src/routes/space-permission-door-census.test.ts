/**
 * Every administrative door, and the space permission it consults.
 *
 * **A census rather than a per-route test, for the reason the credential-mint
 * census exists.** A gate added to nine doors and forgotten on the tenth reads
 * as covered from every angle a per-route test can see: each route that was
 * changed has a passing test, and the one that was not has no failing one. The
 * property worth asserting is the shape of the whole surface.
 *
 * **What this can and cannot see, now that there is no rank.** It used to scan
 * for handlers admitting on the retired rank gate and report the ones with no
 * capability beside them, and that worked because rank had a distinctive
 * signature in the source. It has none now: `requireAuth` is ordinary
 * authentication and sits on nearly every door, so a scan keyed on it reports
 * the whole route table. What survives is the half that still has a signature
 * — every door that does consult a permission is consulting the right one for
 * its own surface, and the files reached through the shared resolver are seen
 * at all. A door that should ask and does not is no longer detectable by
 * reading the source, and needs an explicit list rather than a scanner.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROUTES_DIR = join(import.meta.dirname, ".");

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

/**
 * Helpers that hold a door to a permission on its callers' behalf.
 *
 * A door gated through one of these names is gated, and the scanner has to say
 * so or the four `/keys` doors become invisible the moment they share a line.
 * The helper's own body is skipped for the same reason `_space-caller.ts` is:
 * it is not a surface, and counting it would credit a door that does not exist
 * while leaving the real ones unattributed.
 *
 * Adding a name here is a deliberate act, which is the point — a helper that
 * wraps a gate has to be declared before the census will credit it.
 */
const GATE_HELPERS: Readonly<Record<string, string>> = {
  requireSpaceKeysOrOperator: "keys.mint",
};

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
    for (const [name, permission] of Object.entries(GATE_HELPERS)) {
      if ((lines[i] ?? "").includes(`${name}(`)) return permission;
    }
  }
  return null;
}

/**
 * Whether `line` sits inside the body of a gate helper rather than a handler.
 *
 * Walks back to the nearest function declaration, stopping at a route
 * registration, so a helper defined between two routes is still recognised.
 */
function insideGateHelper(lines: readonly string[], line: number): boolean {
  for (let i = line - 1; i >= 0; i--) {
    const text = lines[i] ?? "";
    if (routeStart(text) !== null) return false;
    const declared = /^(?:export )?function (\w+)\s*\(/.exec(text);
    if (declared)
      return declared[1] !== undefined && declared[1] in GATE_HELPERS;
  }
  return false;
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
      const consultsPermission =
        text.includes("requireSpacePermission(") ||
        Object.keys(GATE_HELPERS).some((name) => text.includes(`${name}(`));
      if (!consultsPermission) return;
      if (insideGateHelper(lines, i + 1)) return;
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

describe("every administrative door consults a space permission", () => {
  const sites = census();

  it("finds the surface at all, so an empty census cannot pass", () => {
    // A scanner that stops matching reports a clean sweep. This is what makes
    // the assertions below mean something.
    expect(sites.length).toBeGreaterThan(15);
  });

  it("reads a permission off every site it counts", () => {
    // The scanner's own health. A site it can see but cannot attribute would
    // be excluded from the mapping check below without anything saying so,
    // which is the failure mode that reads as a clean sweep.
    const unattributed = sites
      .filter((s) => s.spacePermission === null)
      .map((s) => `${s.file}:${String(s.line)} ${s.handler}`);
    expect(unattributed).toEqual([]);
  });

  it("matches the surface exactly, in both directions", () => {
    // **The count is pinned, not only the permission**, and that is what the
    // rank gate used to give for free. The rank check marked which doors
    // needed a permission, so a new one arriving unmarked was visible in the
    // source; with rank retired nothing marks them, and a door added to a
    // space surface with no permission beside it reads exactly like a door
    // that never needed one.
    //
    // So the surface is written down. A door losing its gate drops its count
    // and reddens here; a door gated on the wrong literal reddens here; and a
    // new gated door has to be added deliberately, which is the moment someone
    // asks whether the literal is right.
    //
    // **What this still cannot see is a new door that consults nothing at
    // all**, in a file that already has gated siblings. Nothing in the source
    // distinguishes it from the open reads those files legitimately carry —
    // `GET /types` and `GET /edge-types` are open on purpose — so it is a
    // judgement at review rather than a property a scan can hold. Said plainly
    // here rather than left as an absence, because an absence reads as
    // coverage.
    const expected: Record<string, Record<string, number>> = {
      "audit.ts": { "audit.read": 1 },
      "auth-pages.ts": { "grants.manage": 2 },
      "bulk.ts": { "items.purge": 1 },
      "edge-types.ts": { "schema.write": 1 },
      "items.ts": { "items.purge": 1 },
      "keys.ts": { "keys.mint": 4 },
      "spaces.ts": { "config.manage": 2 },
      "types.ts": { "schema.write": 2 },
      "webhooks.ts": { "webhooks.manage": 6 },
    };

    const actual: Record<string, Record<string, number>> = {};
    for (const site of sites) {
      const permission = site.spacePermission ?? "none";
      const byPermission = (actual[site.file] ??= {});
      byPermission[permission] = (byPermission[permission] ?? 0) + 1;
    }
    expect(actual).toEqual(expected);
  });
});
