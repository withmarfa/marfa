/** @jsxRuntime automatic */
/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { Icon } from "../icons.js";
import { dataAttributes } from "./data.js";

export interface TextFieldProps {
  id: string;
  name: string;
  label: string;
  type?: "text" | "email" | "url" | "number" | "tel";
  value?: string;
  placeholder?: string;
  hint?: Child;
  /** Shown instead of the hint, and marks the field invalid. */
  error?: Child;
  /**
   * Marks the field invalid with no message of its own, for a refusal that
   * covers more than one field. Names the id of the message that explains it,
   * which sits under another field.
   */
  invalidBy?: string;
  autocomplete?: string;
  required?: boolean;
  readonly?: boolean;
  /** Fill the width of its container instead of 240 pixels. */
  full?: boolean;
  maxlength?: number;
  /** A message the form module shows for a pattern mismatch. */
  validateMessage?: string;
  /** What the form module says when a required field is empty. */
  requiredMessage?: string;
  /** Sits on the label's line, at the right: a "Forgot?" link. */
  labelEnd?: Child;
  /** A value copied by hand, such as a setup code: monospace, shown in upper case. */
  code?: boolean;
  /** Takes focus when the page loads, for a field the server marked invalid. */
  autofocus?: boolean;
  /** Read by the browser module that drives the field, as `data-*` attributes. */
  data?: Readonly<Record<string, string>>;
}

interface FieldFrameProps {
  id: string;
  label: string;
  hint?: Child;
  error?: Child;
  labelEnd?: Child;
  children?: Child;
}

function describedBy(props: {
  id: string;
  hint?: Child;
  error?: Child;
  invalidBy?: string;
}) {
  if (props.error !== undefined) return `${props.id}-err`;
  const ids = [
    props.invalidBy,
    props.hint !== undefined ? `${props.id}-hint` : undefined,
  ].filter((id) => id !== undefined);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function isInvalid(props: { error?: Child; invalidBy?: string }): boolean {
  return props.error !== undefined || props.invalidBy !== undefined;
}

function inputClass(props: { full?: boolean; code?: boolean }): string {
  return ["input", props.full ? "full" : "", props.code ? "code" : ""]
    .filter((name) => name !== "")
    .join(" ");
}

function FieldFrame(props: FieldFrameProps) {
  const label = (
    <label class="label" for={props.id}>
      {props.label}
    </label>
  );
  return (
    <div class="field">
      {props.labelEnd !== undefined ? (
        <div class="label-line">
          {label}
          {props.labelEnd}
        </div>
      ) : (
        label
      )}
      {props.children}
      {props.error !== undefined ? (
        <p class="err" id={`${props.id}-err`}>
          {props.error}
        </p>
      ) : (
        props.hint !== undefined && (
          <p class="hint" id={`${props.id}-hint`}>
            {props.hint}
          </p>
        )
      )}
    </div>
  );
}

export function TextField(props: TextFieldProps) {
  return (
    <FieldFrame {...props}>
      <input
        class={inputClass(props)}
        id={props.id}
        name={props.name}
        type={props.type ?? "text"}
        value={props.value}
        placeholder={props.placeholder}
        autocomplete={props.autocomplete}
        required={props.required}
        readonly={props.readonly}
        maxlength={props.maxlength}
        autofocus={props.autofocus}
        aria-invalid={isInvalid(props) ? "true" : undefined}
        aria-describedby={describedBy(props)}
        data-validate-msg={props.validateMessage}
        data-required-msg={props.requiredMessage}
        {...dataAttributes(props.data)}
      />
    </FieldFrame>
  );
}

export type PasswordFieldProps = Omit<
  TextFieldProps,
  "type" | "value" | "placeholder" | "readonly" | "maxlength"
> & {
  /** Fewest characters; the form module says so when a typed value falls short. */
  minlength?: number;
};

/** A password never comes back to the page, so it takes no value. */
export function PasswordField(props: PasswordFieldProps) {
  return (
    <FieldFrame {...props}>
      <div class="pw-wrap" data-password>
        <input
          class={inputClass(props)}
          id={props.id}
          name={props.name}
          type="password"
          autocomplete={props.autocomplete}
          required={props.required}
          minlength={props.minlength}
          autofocus={props.autofocus}
          aria-invalid={isInvalid(props) ? "true" : undefined}
          aria-describedby={describedBy(props)}
          data-validate-msg={props.validateMessage}
          data-required-msg={props.requiredMessage}
        />
        <button
          type="button"
          class="pw-toggle"
          data-password-toggle
          aria-label="Show password"
          aria-pressed="false"
          title="Show password"
          hidden
        >
          <span data-icon-show>
            <Icon name="eye" />
          </span>
          <span data-icon-hide hidden>
            <Icon name="eyeOff" />
          </span>
        </button>
      </div>
    </FieldFrame>
  );
}

export interface SearchFieldProps {
  name?: string;
  value?: string;
  placeholder: string;
  full?: boolean;
  /**
   * Shows the shortcut that opens the command search, as a button that opens
   * it. Both start hidden and the script shows them, once it knows the
   * platform and that the page carries the search.
   */
  shortcutHint?: boolean;
}

export function SearchField(props: SearchFieldProps) {
  return (
    <div class={props.full ? "search full" : "search"}>
      <Icon name="search" />
      <input
        type="search"
        name={props.name ?? "q"}
        value={props.value}
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        autocomplete="off"
      />
      {props.shortcutHint && (
        <button
          type="button"
          class="hint"
          aria-label="Open the search for every page and setting"
          data-command-search-open
          hidden
        >
          <kbd data-shortcut-hint></kbd>
        </button>
      )}
    </div>
  );
}

export interface FormFootProps {
  /** A line on the left of the buttons. */
  note?: Child;
  /** The buttons, the main one last. */
  children?: Child;
}

/** The end of a form: its buttons on the right. */
export function FormFoot(props: FormFootProps) {
  return (
    <div class="formfoot">
      {props.note !== undefined && <span class="note">{props.note}</span>}
      {props.children}
    </div>
  );
}
