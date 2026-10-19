/**
 * The page a browser gets when a navigation fails.
 *
 * Every error this server produced was JSON, including the ones a person
 * reaches by typing a URL or following a stale link. A mistyped `/aut/sign-in`
 * answered with `{"error":{"code":"not_found",…}}` rendered as raw text in the
 * viewport — which reads as the site being broken rather than the address
 * being wrong, and offers nothing to do next.
 *
 * The API contract is untouched. Content negotiation decides: a client asking
 * for JSON, or not asking for HTML, still gets exactly the JSON body it got
 * before, byte for byte. Only a request that explicitly prefers HTML gets a
 * page, because only a browser sends that.
 *
 * **Deliberately parameterless beyond the status.** An error page is reachable
 * by anyone, on any path, with any query — so every value on it that came from
 * the request is a value an attacker chose. Fixed copy keyed on the status
 * class is what makes it safe to render at all, which is the same reasoning
 * the authorize-expired page carries.
 */
import { renderDocument } from "../pages/render.js";
import { Button } from "../pages/parts/controls.js";
import { MomentCard } from "../pages/parts/layout.js";
import { PageShell } from "../pages/parts/shell.js";

/** Does this request want a page rather than a payload? */
export function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false;
  // `Accept: */*` is what fetch and curl send by default, and treating it as
  // "wants HTML" would turn every API error into a page. A browser navigation
  // names text/html explicitly and ranks it first.
  const lowered = accept.toLowerCase();
  if (!lowered.includes("text/html")) return false;
  const jsonIndex = lowered.indexOf("application/json");
  if (jsonIndex === -1) return true;
  // Both named: prefer whichever appears first, which is how browsers and
  // API clients each order their own.
  return lowered.indexOf("text/html") < jsonIndex;
}

interface ProblemCopy {
  title: string;
  lede: string;
}

/**
 * Copy by status class, not by error code. A person does not need to know
 * which of forty codes fired; they need to know whether the thing they asked
 * for exists, whether they are allowed it, and whether trying again helps.
 */
function copyFor(status: number): ProblemCopy {
  if (status === 404) {
    return {
      title: "That page isn't here",
      lede: "It may have been removed, or the address is wrong.",
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: "You can't open this page",
      lede: "You may need to sign in, or this page may not be open to you.",
    };
  }
  if (status === 429) {
    return {
      title: "Too many attempts",
      lede: "Wait a few minutes, then try again.",
    };
  }
  if (status >= 500) {
    return {
      title: "Something went wrong",
      lede: "Marfa logged what happened. Try again.",
    };
  }
  return {
    title: "That didn't work",
    lede: "The request could not be completed. Check the address, then try again.",
  };
}

export interface ErrorPageOptions {
  /**
   * Offer "Try again" on a server fault. Only for a request that is safe to
   * make again by following the same address, which is a GET.
   */
  retry?: boolean;
}

export function renderHttpErrorPage(
  status: number,
  nonce: string,
  options: ErrorPageOptions = {},
): string {
  const copy = copyFor(status);
  const home = (
    <Button kind="primary" wide={!(status >= 500 && options.retry)} href="/">
      Go to Home
    </Button>
  );
  return renderDocument(
    <PageShell title={copy.title} nonce={nonce}>
      <MomentCard
        title={copy.title}
        lede={copy.lede}
        ledeRole="alert"
        foot={`Error ${String(status)}`}
      >
        {status >= 500 && options.retry ? (
          <div class="pair">
            <Button kind="outline" href="">
              Try again
            </Button>
            {home}
          </div>
        ) : (
          home
        )}
      </MomentCard>
    </PageShell>,
  );
}
