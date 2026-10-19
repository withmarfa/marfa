/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";

export interface DialogProps {
  /** The id a button names in `opens`. */
  id: string;
  title: string;
  description?: Child;
  /** The buttons, in a row under the body. */
  actions: Child;
  children?: Child;
}

/**
 * A modal dialog, the browser's own `<dialog>`: it stays closed until a button
 * names it, takes focus while it is open, closes on Escape, and gives focus
 * back to the button that opened it.
 */
export function Dialog(props: DialogProps) {
  const titleId = `${props.id}-title`;
  const descriptionId = `${props.id}-description`;
  return (
    <dialog
      id={props.id}
      class="dialog"
      aria-labelledby={titleId}
      aria-describedby={
        props.description !== undefined ? descriptionId : undefined
      }
    >
      <div class="card">
        <div>
          <h2 class="ctitle" id={titleId}>
            {props.title}
          </h2>
          {props.description !== undefined && (
            <p class="lede" id={descriptionId}>
              {props.description}
            </p>
          )}
        </div>
        {props.children}
        <div class="pair">{props.actions}</div>
      </div>
    </dialog>
  );
}
