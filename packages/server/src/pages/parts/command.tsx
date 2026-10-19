/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

/**
 * A command for a person to run in a terminal. The Copy button needs the
 * script, so it starts hidden and the script shows it.
 */
export function CommandBlock(props: { command: string }) {
  return (
    <div class="cmd">
      <code>{props.command}</code>
      <button
        type="button"
        class="btn"
        data-copy={props.command}
        aria-label={`Copy ${props.command}`}
        hidden
      >
        Copy
      </button>
    </div>
  );
}

/**
 * Help that stays out of the way until asked for: the browser's own
 * `<details>`, so it opens without a script and with the keyboard.
 */
export function Disclosure(props: { summary: string; children?: Child }) {
  return (
    <details class="disclosure">
      <summary>{props.summary}</summary>
      {props.children}
    </details>
  );
}
