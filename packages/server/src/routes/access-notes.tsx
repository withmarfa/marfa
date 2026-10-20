/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

/**
 * The two lines under an approval card. Marfa never knows who made an app, so
 * the first is always said: any program can pick any name when it registers.
 */
export function ApprovalFoot() {
  return (
    <>
      Marfa can't confirm who made this app. Only approve apps you trust.
      <br />
      You can end its access at any time in Connected apps.
    </>
  );
}

/** Joins items as a list a sentence can hold: "A", "A and B", "A, B, and C". */
function joined(items: readonly Child[]): Child[] {
  const out: Child[] = [];
  items.forEach((item, i) => {
    if (i > 0)
      out.push(
        i === items.length - 1 ? (items.length > 2 ? ", and " : " and ") : ", ",
      );
    out.push(item);
  });
  return out;
}

/** An origin as a person reads it: the scheme of a secure address is understood. */
const shown = (origin: string): string => origin.replace(/^https:\/\//, "");

/**
 * The addresses an approval lets reach the server from a browser, or nothing
 * for an app with none. One part for both approval screens, so the owner
 * confirms the same addresses whichever the flow put them on.
 */
export function WebOriginNote(props: { origins: readonly string[] }) {
  if (props.origins.length === 0) return null;
  return (
    <p class="small muted">
      Approving also lets{" "}
      {joined(
        props.origins.map((origin) => (
          <strong class="strong">{shown(origin)}</strong>
        )),
      )}{" "}
      reach Marfa from your browser.
    </p>
  );
}

/**
 * Said while nothing is on. The page shows it to a browser that runs no
 * script, because there is nothing to hide it; the script hides it as soon as
 * something is on.
 */
export function EverythingOffNote() {
  return (
    <p class="small muted" data-access-nothing>
      If everything is off, approving denies the request.
    </p>
  );
}
