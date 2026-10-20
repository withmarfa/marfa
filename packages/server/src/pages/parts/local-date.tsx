/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { dateFormat } from "../local-date.js";

const UTC = dateFormat("UTC");

/**
 * A date as "October 3, 2026". The text is the UTC date; the browser module
 * `client/local-date.ts` writes it again in the viewer's time zone, and
 * `datetime` keeps the whole instant.
 */
export function LocalDate(props: { at: Date }) {
  return (
    <time datetime={props.at.toISOString()} data-local-date="">
      {UTC.format(props.at)}
    </time>
  );
}
