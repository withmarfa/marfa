/**
 * Result page for a sign-in link that did not work, rendered by
 * `GET /auth/sign-in/complete` when the magic-link verify bounced.
 *
 * The verify step consumes its token atomically and reports one code,
 * `INVALID_TOKEN`, for a link that had already been used and for one that had
 * timed out. Those are genuinely indistinguishable by the time we are asked,
 * so the copy names both rather than picking one and being wrong half the
 * time. Telling a user their link expired when they had in fact already used
 * it sends them looking for a clock problem that isn't there.
 *
 * The way forward is a fresh link, so the primary action asks for one. It
 * carries `return_to` through, which is what puts the user back where they
 * started rather than at the root.
 *
 * One bounce is not a dead link at all: when sign-up is closed, a link
 * resolving to an address with no account is refused deliberately. The
 * retry copy is actively wrong there — another link bounces the same way,
 * so offering one loops the user forever. That case gets its own copy and
 * no retry button, on the same reasoning the paragraph above uses for the
 * expiry pair: telling somebody the wrong cause sends them looking for a
 * problem that isn't theirs.
 */

import { renderAuthLayout } from "./auth-layout.js";
import { escapeHtml, buildQuery, confirmIcon } from "./auth-html.js";

interface SignInLinkFailedParams {
  /** Where the user was heading before sign-in interrupted them. Threaded
   *  onto the "send another" link so a fresh attempt resumes rather than
   *  restarts. */
  returnTo: string;
  /** Why the verify bounced. Defaults to the `INVALID_TOKEN` pair (spent
   *  or timed out). `signup_closed` is the magic-link plugin refusing to
   *  create an account on an instance that has sign-up switched off. */
  reason?: "expired" | "signup_closed";
  /**
   * The host this instance answers as, named in the sign-up-closed copy.
   *
   * Comes from the instance's configured base URL rather than the request,
   * because the request's host is whatever the client sent and this string
   * is rendered back to them. Omitted when there is no host worth naming,
   * and the copy then reads as it did before. Resolve it with
   * {@link hostFromBaseUrl}, which decides what "worth naming" means.
   */
  host?: string;
}

/**
 * Hostnames this page must never name, as the URL parser spells them.
 *
 * Six entries covering three things in both address families: the loopback
 * name, the loopback address, and the unspecified address. `[::ffff:7f00:1]`
 * is how an IPv4-mapped loopback normalizes.
 *
 * **Not a completeness claim about loopback addressing.** `127.0.0.0/8` is a
 * whole /8 and only `127.0.0.1` of it is here, deliberately: the rest are
 * addresses somebody chose on purpose rather than a default anybody arrives
 * at by not configuring one. The earlier version of this comment said the
 * set held three members of that /8, which was wrong about both the count
 * and the /8 — `localhost` is a name, `0.0.0.0` is the unspecified address,
 * and the IPv6 pair are neither. A completeness claim written from the
 * entries its author happened to be looking at is the exact failure this
 * file's first review found one docblock away.
 *
 * **Shorthand spellings need no entries.** The parser normalizes `127.1`,
 * `2130706433` and `0x7f000001` to `127.0.0.1`, `0` to `0.0.0.0`, and any
 * spelling of the IPv6 loopback to `[::1]`, all before this set is asked.
 * IDNA folds case and homoglyphs the same way. Verified rather than assumed.
 */
const UNNAMEABLE_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "[::]",
  "[::ffff:7f00:1]",
]);

/**
 * The host part of a base URL, or undefined when there is no host worth
 * naming.
 *
 * A pure function of its argument, deliberately. The value it wants is the
 * configured `MARFA_AUTH_BASE_URL`, and the caller reads that from
 * `c.var.config` rather than from the environment, so that the rule
 * resolving it lives in one place. An earlier draft read the variable here
 * and diverged from that rule: config falls back to a localhost URL when
 * the variable is unset and this file returned nothing, so the two
 * disagreed about the same deployment. Reading config fixes the divergence
 * and creates the second problem this function exists to solve.
 *
 * **A loopback host is refused, and that is the whole reason this is not a
 * one-line `new URL().host`.** With the variable unset, config resolves to
 * `http://localhost:<port>`. Naming that is worse than naming nothing:
 * somebody who reached this page at `notes.example.com` and reads
 * "sign-in links on localhost:8600" has been told something that cannot be
 * true of the server they are talking to, which is the exact confusion this
 * copy exists to remove. The same holds for a value explicitly set to
 * localhost, so the test is on the value rather than on where it came from.
 *
 * A malformed value yields nothing rather than throwing, because this is an
 * error page and a second failure is least welcome here of anywhere.
 */
export function hostFromBaseUrl(
  baseUrl: string | undefined,
): string | undefined {
  if (!baseUrl) return undefined;
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  // `hostname` is already lower-cased by the URL parser, so this compares
  // against a set of lower-case names and does no folding of its own. That
  // was checked by breaking it: a `toLowerCase()` here survived every
  // mutation, because nothing it could have done was left to do.
  //
  // The trailing dot is ours to handle, because the parser only strips it
  // from some hosts: `127.0.0.1.` normalizes to `127.0.0.1` while
  // `localhost.` stays `localhost.`, which is a legitimate fully-qualified
  // spelling and would otherwise walk straight past the set.
  const hostname = url.hostname.replace(/\.$/, "");
  if (UNNAMEABLE_HOSTNAMES.has(hostname)) return undefined;
  return url.host || undefined;
}

/** Renders the dead-sign-in-link page as a full HTML document. */
export function renderSignInLinkFailedPage(
  params: SignInLinkFailedParams,
): string {
  if (params.reason === "signup_closed") {
    const title = "This space isn't open for new accounts";
    // Naming the host is the whole of this copy's job beyond the refusal.
    // The refusal itself stays deliberately silent about whether the address
    // has an account, so that sign-in cannot be used to discover which
    // addresses exist. Naming the host leaks nothing the address bar does not
    // already show, on the condition that the configured base URL is the
    // public origin — which is what it is for, and a deployment that points
    // it at an internal name is already sending that name out in every
    // emailed link. What it fixes is the reading: an account holder on
    // another instance sees a message that appears to be about their account
    // rather than about which server they are on, and goes looking for a
    // problem that is not theirs.
    // One deictic throughout. An earlier draft said links "only work for
    // accounts that already exist there" and then that another server's
    // account "won't work here", with both words denoting this server. The
    // reader being addressed is by definition unsure which server they are
    // on, so two words for it is the one thing this copy cannot afford.
    const where = params.host
      ? `Sign-in links on ${escapeHtml(params.host)} only work for accounts that already exist here`
      : "Sign-in links only work for accounts that already exist here";
    return renderAuthLayout({
      title,
      bodyHtml: `
    ${confirmIcon("alert")}
    <h1 class="title">${title}</h1>
    <p class="sub" role="alert">${where}, and this space isn't accepting new ones. An account on a different Marfa server won't work here. If you should have an account, ask whoever runs this space.</p>
  `,
      centered: true,
    });
  }

  const retryHref = `/auth/sign-in?${buildQuery({
    mode: "magic",
    return_to: params.returnTo,
  })}`;
  const bodyHtml = `
    ${confirmIcon("alert")}
    <h1 class="title">That sign-in link didn't work</h1>
    <p class="sub" role="alert">A sign-in link works once and lasts a few minutes. This one had already been used, or it had run out of time. Send yourself another and it will work.</p>
    <div class="actions">
      <a href="${escapeHtml(retryHref)}" class="btn btn--primary">Send another link</a>
    </div>
  `;
  return renderAuthLayout({
    title: "That sign-in link didn't work",
    bodyHtml,
    centered: true,
  });
}
