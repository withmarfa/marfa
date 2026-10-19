import type { Child } from "hono/jsx";
import { localHref } from "../href.js";
import { Icon } from "../icons.js";

interface RowCommon {
  id?: string;
  title: string;
  description?: string;
  descriptionTone?: "danger";
  value?: string;
  valueTone?: "danger";
}

/** Ends in its value, if any, and a chevron: it opens something. */
interface LinkRow extends RowCommon {
  href: string;
  opens?: never;
  control?: never;
  buttons?: never;
}

/** Ends in its value and a chevron, and opens a dialog. */
interface DialogRow extends RowCommon {
  opens: string;
  href?: never;
  control?: never;
  buttons?: never;
}

/** Ends in a control, which the row's title labels when `for` names it. */
interface ControlRow extends RowCommon {
  control: Child;
  for?: string;
  href?: never;
  opens?: never;
  buttons?: never;
}

/** Ends in buttons. */
interface ButtonsRow extends RowCommon {
  buttons: Child;
  href?: never;
  opens?: never;
  control?: never;
}

/** Shows a value and nothing to act on. */
interface ValueRow extends RowCommon {
  href?: never;
  opens?: never;
  control?: never;
  buttons?: never;
}

export type RowProps = LinkRow | DialogRow | ControlRow | ButtonsRow | ValueRow;

/** A description longer than this is also its tooltip, because a list cuts it short. */
const LONG_DESCRIPTION = 70;

export function Row(props: RowProps) {
  const className = `row${props.description ? " has-d" : ""}`;
  const description = props.description && (
    <div
      class={props.descriptionTone ? `rd ${props.descriptionTone}` : "rd"}
      title={
        props.description.length > LONG_DESCRIPTION
          ? props.description
          : undefined
      }
    >
      {props.description}
    </div>
  );
  const text = (
    <>
      <div class="rt">{props.title}</div>
      {description}
    </>
  );
  const value = props.value !== undefined && props.value !== "" && (
    <span class={props.valueTone ? `val ${props.valueTone}` : "val"}>
      {props.value}
    </span>
  );
  const chevron = (
    <span class="chev">
      <Icon name="chevron" />
    </span>
  );

  if (props.href !== undefined) {
    return (
      <a class={className} href={localHref(props.href)} id={props.id}>
        <div class="grow">{text}</div>
        {value}
        {chevron}
      </a>
    );
  }
  if (props.opens !== undefined) {
    return (
      <button
        class={className}
        type="button"
        id={props.id}
        data-dialog-open={props.opens}
      >
        <div class="grow">{text}</div>
        {value}
        {chevron}
      </button>
    );
  }
  if (props.control !== undefined) {
    return (
      <div class={className} id={props.id}>
        {props.for ? (
          <label class="grow" for={props.for}>
            {text}
          </label>
        ) : (
          <div class="grow">{text}</div>
        )}
        {value}
        {props.control}
      </div>
    );
  }
  return (
    <div class={className} id={props.id}>
      <div class="grow">{text}</div>
      {value}
      {props.buttons !== undefined && <span class="ends">{props.buttons}</span>}
    </div>
  );
}

export interface RowGroupProps {
  /** Keep each row to one line, cut short with an ellipsis: for a list. */
  oneLine?: boolean;
  children?: Child;
}

/** A box of rows. */
export function RowGroup(props: RowGroupProps) {
  return (
    <div class={props.oneLine ? "group oneline" : "group"}>
      {props.children}
    </div>
  );
}

/**
 * What ends a page by acting on the whole of it (revoke, sign out the others):
 * rows without a box, under a thin line.
 */
export function ClosingAction(props: { children?: Child }) {
  return <div class="closing">{props.children}</div>;
}
