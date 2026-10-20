/**
 * Writes a device code as it is typed: capitals, with the dash after the
 * fourth character, whatever case, spaces or dash the person used. The field
 * is a plain text field without it, and the server reads the same code.
 *
 * The cursor stays after the same letters and digits it was after, so a
 * correction in the middle of a code does not jump to the end. A Backspace
 * over the dash deletes the character before it, and a Delete before it the
 * character after, because the dash alone would only be written back.
 */
import {
  charactersBefore,
  formatDeviceCode,
  positionAfter,
} from "../device-code.js";

function rewrite(field: HTMLInputElement, count: number): void {
  const formatted = formatDeviceCode(field.value);
  field.value = formatted;
  const caret = positionAfter(formatted, count);
  field.setSelectionRange(caret, caret);
}

export function initDeviceCode(): void {
  for (const field of document.querySelectorAll<HTMLInputElement>(
    "input[data-device-code]",
  )) {
    const initial = formatDeviceCode(field.value);
    if (initial !== field.value) field.value = initial;
    field.addEventListener("input", () => {
      const caret = field.selectionStart ?? field.value.length;
      const count = charactersBefore(field.value, caret);
      if (formatDeviceCode(field.value) !== field.value) rewrite(field, count);
    });
    field.addEventListener("keydown", (event) => {
      if (field.selectionStart !== field.selectionEnd) return;
      const caret = field.selectionStart ?? 0;
      const value = field.value;
      if (event.key === "Backspace" && caret === 5 && value[4] === "-") {
        event.preventDefault();
        field.value = value.slice(0, 3) + value.slice(4);
        rewrite(field, 3);
      } else if (event.key === "Delete" && caret === 4 && value[4] === "-") {
        event.preventDefault();
        field.value = value.slice(0, 5) + value.slice(6);
        rewrite(field, 4);
      }
    });
  }
}
