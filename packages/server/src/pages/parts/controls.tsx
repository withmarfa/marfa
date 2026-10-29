/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { localHref } from "../href.js";
import { Icon, type IconName } from "../icons.js";
import { dataAttributes } from "./data.js";

export type ButtonKind =
  "primary" | "quiet" | "outline" | "danger" | "danger-quiet" | "icon-only";

export interface ButtonProps {
  kind?: ButtonKind;
  /** A link that looks like a button. Without it, a button. */
  href?: string;
  type?: "button" | "submit";
  wide?: boolean;
  disabled?: boolean;
  /**
   * Looks and reads as unavailable but still takes focus and a press, for a
   * button whose reason the page states beside it. The script decides what a
   * press does.
   */
  ariaDisabled?: boolean;
  /** The accessible name, for a button that holds only an icon. */
  label?: string;
  /** Opens the dialog with this id. */
  opens?: string;
  /** Closes the dialog it sits in. */
  closes?: boolean;
  /** What a submit button says while its form is sending. */
  loadingLabel?: string;
  form?: string;
  name?: string;
  value?: string;
  /** An icon before the label. */
  icon?: IconName;
  /** Starts hidden, for a button the script shows once it knows it can work. */
  hidden?: boolean;
  /** Names the button to the browser module that drives it. */
  hook?: string;
  /** Read by the browser module that drives the page, as `data-*` attributes. */
  data?: Readonly<Record<string, string>>;
  children?: Child;
}

export function Button(props: ButtonProps) {
  const kind = props.kind ?? "quiet";
  const className = `btn ${kind}${props.wide ? " wide" : ""}`;
  if (props.href !== undefined) {
    return (
      <a
        class={className}
        href={localHref(props.href, { relative: true })}
        aria-label={props.label}
        title={props.kind === "icon-only" ? props.label : undefined}
        hidden={props.hidden}
        data-hook={props.hook}
        {...dataAttributes(props.data)}
      >
        {props.icon !== undefined && <Icon name={props.icon} />}
        {props.children}
      </a>
    );
  }
  return (
    <button
      class={className}
      type={props.type ?? "button"}
      disabled={props.disabled}
      aria-disabled={props.ariaDisabled ? "true" : undefined}
      aria-label={props.label}
      title={kind === "icon-only" ? props.label : undefined}
      data-dialog-open={props.opens}
      data-dialog-close={props.closes ? "" : undefined}
      data-loading-label={props.loadingLabel}
      form={props.form}
      name={props.name}
      value={props.value}
      hidden={props.hidden}
      data-hook={props.hook}
      {...dataAttributes(props.data)}
    >
      {props.icon !== undefined && <Icon name={props.icon} />}
      {props.children}
    </button>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectGroup {
  label: string;
  options: readonly SelectOption[];
}

export interface SelectProps {
  id?: string;
  name?: string;
  /** The accessible name, when no visible label points at the select. */
  label?: string;
  /** The id of the element that describes the select, which a screen reader reads after its name. */
  describedBy?: string;
  value?: string;
  options: readonly (SelectOption | SelectGroup)[];
  disabled?: boolean;
  /** Shrink to the width of the longest option. */
  auto?: boolean;
  /** Send the form it is in when the choice changes. */
  autosubmit?: boolean;
  /** Read by the browser module that drives the page, as `data-*` attributes. */
  data?: Readonly<Record<string, string>>;
}

function renderOption(option: SelectOption, value: string | undefined) {
  return (
    <option value={option.value} selected={option.value === value}>
      {option.label}
    </option>
  );
}

export function Select(props: SelectProps) {
  return (
    <span class={props.auto ? "sel auto" : "sel"}>
      <select
        id={props.id}
        name={props.name}
        aria-label={props.label}
        aria-describedby={props.describedBy}
        disabled={props.disabled}
        data-autosubmit={props.autosubmit ? "" : undefined}
        {...dataAttributes(props.data)}
      >
        {props.options.map((entry) =>
          "options" in entry ? (
            <optgroup label={entry.label}>
              {entry.options.map((option) => renderOption(option, props.value))}
            </optgroup>
          ) : (
            renderOption(entry, props.value)
          ),
        )}
      </select>
      <Icon name="down" />
    </span>
  );
}

export interface SwitchProps {
  id: string;
  name?: string;
  /** What the form sends when the switch is on. */
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  /** The accessible name, when no visible label points at the switch. */
  label?: string;
  /** Read by the browser module that drives the page, as `data-*` attributes. */
  data?: Readonly<Record<string, string>>;
}

export function Switch(props: SwitchProps) {
  return (
    <input
      class="switch"
      type="checkbox"
      role="switch"
      id={props.id}
      name={props.name}
      value={props.value}
      checked={props.checked}
      disabled={props.disabled}
      aria-label={props.label}
      {...dataAttributes(props.data)}
    />
  );
}

export interface RadioProps {
  id: string;
  /** The field the choice posts under. */
  name: string;
  value: string;
  checked?: boolean;
}

/** One choice of several that share a name; a row's title labels it. */
export function Radio(props: RadioProps) {
  return (
    <input
      class="radio"
      type="radio"
      id={props.id}
      name={props.name}
      value={props.value}
      checked={props.checked}
    />
  );
}

/**
 * Two buttons of equal width side by side, the main one last: how a moment
 * ends where the person decides between two things.
 */
export function ButtonPair(props: { children?: Child }) {
  return <div class="pair">{props.children}</div>;
}
