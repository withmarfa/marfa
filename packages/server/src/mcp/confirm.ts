/**
 * The confirmation a delete asks for: a token over what its preview showed.
 *
 * The first `marfa_delete` call previews and returns a token; the second
 * call sends it back, and the delete goes ahead only if a fresh preview
 * gives the same token. The token is a MAC, keyed from the instance's
 * secret, over the credential that asked, every item the preview counted
 * with its version, and an expiry. So a token is refused when it is sent by
 * another credential, after it expires, or once anything the preview showed
 * has changed: an item edited, an item added to or dropped from what the
 * delete takes with it. The token carries only its expiry and the MAC, so
 * it says nothing about the items it covers.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How long a preview's token stays good. */
export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/** One item a delete would trash, with the version the preview saw. */
export interface PlannedItem {
  id: string;
  version: number;
}

/** One requested item and what trashing it takes with it. */
export interface PlannedDelete {
  id: string;
  version: number;
  /** Every readable item trashed with it, and how many there are in all. */
  with: readonly PlannedItem[];
  count: number;
}

function canonical(
  credential: string,
  plan: readonly PlannedDelete[],
  expiresAt: number,
): string {
  const roots = [...plan]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((root) => ({
      id: root.id,
      version: root.version,
      count: root.count,
      with: [...root.with]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((item) => [item.id, item.version]),
    }));
  return JSON.stringify({ credential, roots, expiresAt });
}

function mac(key: Buffer, text: string): string {
  return createHmac("sha256", key).update(text).digest("base64url");
}

/** The token a preview of `plan` returns to `credential`. */
export function confirmationToken(
  key: Buffer,
  credential: string,
  plan: readonly PlannedDelete[],
  now: number,
): { token: string; expires_at: string } {
  const expiresAt = Math.floor((now + CONFIRMATION_TTL_MS) / 1000);
  return {
    token: `${String(expiresAt)}.${mac(key, canonical(credential, plan, expiresAt))}`,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  };
}

export type ConfirmationCheck = "valid" | "malformed" | "expired" | "changed";

/**
 * Whether `token` is the one a preview of `plan` gave `credential`. A token
 * from another credential, or over another plan, reads as `changed`: the
 * MAC cannot tell them apart, and either way the delete is previewed again.
 */
export function checkConfirmation(
  key: Buffer,
  credential: string,
  plan: readonly PlannedDelete[],
  token: string,
  now: number,
): ConfirmationCheck {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (match?.[1] === undefined || match[2] === undefined) return "malformed";
  const expiresAt = Number(match[1]);
  if (expiresAt * 1000 <= now) return "expired";
  const expected = Buffer.from(
    mac(key, canonical(credential, plan, expiresAt)),
  );
  const given = Buffer.from(match[2]);
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? "valid"
    : "changed";
}
