/**
 * The confirmation a tool asks for before a change the person must agree
 * to: a token over what its preview showed.
 *
 * The first call previews and returns a token; the second call sends it
 * back, and the tool goes ahead only if a fresh preview gives the same
 * token. The token is a MAC, keyed from the instance's secret, over the tool
 * that previewed, the credential that asked, what the preview showed and an
 * expiry. So a token is refused when it is sent to another tool or by
 * another credential, after it expires, or once anything the preview
 * covered has changed. The token carries only its expiry and the MAC, so it
 * says nothing about what it covers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a preview's token stays good. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** Who a token is for: the tool that previewed and the credential that asked. */
export interface ConfirmationScope {
  tool: string;
  credential: string;
}

/** JSON with every object's keys in order, so equal subjects give equal text. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  );
}

function mac(
  key: Buffer,
  scope: ConfirmationScope,
  subject: unknown,
  expiresAt: number,
): string {
  return createHmac("sha256", key)
    .update(
      canonicalJson({
        tool: scope.tool,
        credential: scope.credential,
        subject,
        expiresAt,
      }),
    )
    .digest("base64url");
}

/**
 * The token a preview showing `subject` returns. A list in `subject` whose
 * order means nothing is sorted by the caller.
 */
export function confirmationToken(
  key: Buffer,
  scope: ConfirmationScope,
  subject: unknown,
  now: number,
): { token: string; expires_at: string } {
  const expiresAt = Math.floor((now + CONFIRMATION_TTL_MS) / 1000);
  return {
    token: `${String(expiresAt)}.${mac(key, scope, subject, expiresAt)}`,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  };
}

export type ConfirmationCheck = "valid" | "malformed" | "expired" | "changed";

/**
 * Whether `token` is the one a preview showing `subject` gave `scope`. A
 * token from another tool or credential, or over another subject, reads as
 * `changed`: the MAC cannot tell them apart, and either way the tool
 * previews again.
 */
export function checkConfirmation(
  key: Buffer,
  scope: ConfirmationScope,
  subject: unknown,
  token: string,
  now: number,
): ConfirmationCheck {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (match?.[1] === undefined || match[2] === undefined) return "malformed";
  const expiresAt = Number(match[1]);
  if (expiresAt * 1000 <= now) return "expired";
  const expected = Buffer.from(mac(key, scope, subject, expiresAt));
  const given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? "valid"
    : "changed";
}

/** The message a refused confirmation answers with, beside a new preview. */
export function staleConfirmation(
  check: Exclude<ConfirmationCheck, "valid">,
  nothing: string,
): { code: string; message: string } {
  return {
    code: "confirmation_stale",
    message:
      check === "expired"
        ? `The confirmation expired. ${nothing}; here is a new preview.`
        : `What the preview showed changed, or the confirmation is not this preview's. ${nothing}; here is a new preview.`,
  };
}
