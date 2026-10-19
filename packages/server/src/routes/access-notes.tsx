/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { Notice } from "../pages/parts/index.js";

/** The caution beside every app a person is about to approve: any program can pick any name. */
export function UnverifiedAppNotice() {
  return (
    <Notice title="Marfa can't confirm who made this app">
      Only approve apps you trust.
    </Notice>
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

/**
 * The addresses an approval lets reach the server from a browser, or nothing
 * for an app with none. One part for both approval screens, so the owner
 * confirms the same addresses whichever the flow put them on.
 */
export function WebOriginNote(props: { origins: readonly string[] }) {
  if (props.origins.length === 0) return null;
  const named = props.origins.map((origin) => <strong>{origin}</strong>);
  return (
    <p class="secd">
      Approving also lets{" "}
      {props.origins.length === 1 ? "the web page at " : "web pages at "}
      {joined(named)} reach Marfa from your browser.
    </p>
  );
}
