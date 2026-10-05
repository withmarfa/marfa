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
import { renderAuthLayout } from "./auth-layout.js";
import { confirmIcon } from "./auth-html.js";

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

interface ErrorPageCopy {
  title: string;
  heading: string;
  body: string;
  icon: "alert" | "check" | "mail";
}

/**
 * Copy by status class, not by error code. A person does not need to know
 * which of forty codes fired; they need to know whether the thing they asked
 * for exists, whether they are allowed it, and whether trying again helps.
 */
function copyFor(status: number): ErrorPageCopy {
  if (status === 404) {
    return {
      title: "Page not found",
      heading: "That page isn't here",
      body: "The address may be wrong, or the page may have moved.",
      icon: "alert",
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: "Not available",
      heading: "You can't reach this page",
      body: "You may need to sign in, or this may belong to someone else.",
      icon: "alert",
    };
  }
  if (status === 429) {
    return {
      title: "Too many requests",
      heading: "Too many attempts",
      body: "Wait a minute, then try again. The limit clears on its own.",
      icon: "alert",
    };
  }
  return {
    title: "Something went wrong",
    heading: "Something went wrong at our end",
    body: "This one is ours, not yours. We have a record of it.",
    icon: "alert",
  };
}

export function renderHttpErrorPage(status: number, nonce: string): string {
  const copy = copyFor(status);
  return renderAuthLayout({
    title: copy.title,
    centered: true,
    nonce,
    bodyHtml: `
      ${confirmIcon(copy.icon)}
      <h1 class="title">${copy.heading}</h1>
      <p class="sub" role="alert">${copy.body}</p>
    `,
  });
}
