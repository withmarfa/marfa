/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import { Button } from "./controls.js";

export interface SaveBarProps {
  /** The id of the form it saves: the Save button submits that form. */
  form: string;
}

/**
 * The bar an edit page shows, pinned to the bottom of the viewport, once its
 * form differs from what the page loaded: how many controls changed on the
 * left, Discard and Save on the right. It starts hidden and `client/save-bar.ts`
 * shows and hides it, so a page of something that exists shows no Save or
 * Discard until there is something to save. A form that makes something new
 * ends in its own buttons instead.
 *
 * Put it last in the page, so a keyboard reaches Discard and Save after the
 * controls and the actions below them. The line outside the bar is a polite
 * status the script writes the count into, so a screen reader hears the bar
 * appear without focus moving.
 */
export function SaveBar(props: SaveBarProps) {
  if (props.form === "")
    throw new Error("SaveBar needs the id of the form it saves");
  return (
    <div class="savebar-host" data-save-bar-form={props.form}>
      <div class="sr" role="status" aria-live="polite" data-save-bar-status />
      <div
        class="savebar"
        role="group"
        aria-label="Unsaved changes"
        data-save-bar
        hidden
      >
        <div class="savebar-in">
          <div class="savebar-row">
            <span class="savebar-count" data-save-bar-count />
            <div class="savebar-actions">
              <Button kind="outline" hook="save-discard">
                Discard
              </Button>
              <Button
                kind="primary"
                type="submit"
                form={props.form}
                loadingLabel="Saving..."
                hook="save-submit"
              >
                Save
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
