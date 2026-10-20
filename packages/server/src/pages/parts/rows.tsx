/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { localHref } from "../href.js";
import { Icon } from "../icons.js";
import { dataAttributes } from "./data.js";

interface RowCommon {
  id?: string;
  title: string;
  /** A line under the title: plain text, or markup such as a {@link LocalDate}. */
  description?: string | Child;
  /** The id of the description line, for a control that names it as its description. */
  descriptionId?: string;
  /** Red for what cannot be undone, amber for what needs a look. */
  descriptionTone?: "danger" | "warn";
  /** A short mark after the title, such as "New". */
  badge?: string;
  value?: string;
  valueTone?: "warn" | "danger";
  /** Let the value take the width it needs, up to half the row, for a name or an address. */
  valueAuto?: boolean;
  /** A dot before the row, for a row that reports something wrong: amber needs a look, red has stopped. */
  dot?: "warn" | "danger";
  /** Starts hidden, for a row the script shows once it knows it can work. */
  hidden?: boolean;
  /** Read by the browser module that drives the page, as `data-*` attributes. */
  data?: Readonly<Record<string, string>>;
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
      id={props.descriptionId}
      class={props.descriptionTone ? `rd ${props.descriptionTone}` : "rd"}
      title={
        typeof props.description === "string" &&
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
      <div class="rt">
        {props.title}
        {props.badge !== undefined && (
          <span class="badge new">{props.badge}</span>
        )}
      </div>
      {description}
    </>
  );
  const value = props.value !== undefined && props.value !== "" && (
    <span
      class={["val", props.valueAuto ? "auto" : "", props.valueTone ?? ""]
        .filter((name) => name !== "")
        .join(" ")}
    >
      {props.value}
    </span>
  );
  const lead = props.dot !== undefined && (
    <span class="lead">
      <span class={`dot ${props.dot}`} aria-hidden="true" />
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
        {lead}
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
        {lead}
        <div class="grow">{text}</div>
        {value}
        {chevron}
      </button>
    );
  }
  if (props.control !== undefined) {
    return (
      <div
        class={className}
        id={props.id}
        hidden={props.hidden}
        {...dataAttributes(props.data)}
      >
        {lead}
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
    <div
      class={className}
      id={props.id}
      hidden={props.hidden}
      {...dataAttributes(props.data)}
    >
      {lead}
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

export interface DangerRowProps {
  id?: string;
  title: string;
  /** What it does and whether it can be undone. */
  description?: string | Child;
  /** The button, which names the act: "Revoke", "Sign out others". */
  action: Child;
}

/**
 * A destructive or closing action (revoke a key, disconnect an app, sign out
 * the other browsers, remove a connector): one row in a card of its own, with
 * a border and no fill, so it reads as secondary to the filled cards above it.
 * Its words sit on the card's left inner edge and its button on the right.
 */
export function DangerRow(props: DangerRowProps) {
  return (
    <div class="group quiet">
      <Row
        id={props.id}
        title={props.title}
        description={props.description}
        buttons={props.action}
      />
    </div>
  );
}

export interface DisclosureRowProps {
  title: string;
  /** The line under the title: what the rows beneath give, in a few words. */
  description?: string;
  /** A short mark after the title, such as "New". */
  badge?: string;
  /** Opens the rows when the page loads. */
  open?: boolean;
  /** Read by the browser module that drives the page, as `data-*` attributes. */
  data?: Readonly<Record<string, string>>;
  /**
   * The browser module that drives the page rewrites the description as the
   * rows beneath change, and finds the line by `data-summary`.
   */
  live?: boolean;
  /** Rows shown beneath the title once it is open. */
  children?: Child;
}

/**
 * A row that opens in place to show more rows, with no script: the browser
 * opens and closes it, and a keyboard does the same with Enter or Space.
 */
export function DisclosureRow(props: DisclosureRowProps) {
  return (
    <details
      class="disclosure-row"
      open={props.open}
      {...dataAttributes(props.data)}
    >
      <summary class={props.description ? "row has-d" : "row"}>
        <div class="grow">
          <div class="rt">
            {props.title}
            {props.badge !== undefined && (
              <span class="badge new">{props.badge}</span>
            )}
          </div>
          {props.description !== undefined && (
            <div class="rd" data-summary={props.live ? "" : undefined}>
              {props.description}
            </div>
          )}
        </div>
        <span class="chev">
          <Icon name="chevron" />
        </span>
      </summary>
      <div class="sub">{props.children}</div>
    </details>
  );
}

/** Small print at the end of what a row opens to. */
export function RowNote(props: { children?: Child }) {
  return <p class="sub-note">{props.children}</p>;
}
