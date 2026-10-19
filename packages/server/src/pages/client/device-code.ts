/**
 * Writes a device code as it is typed: capitals, with the dash after the
 * fourth character, whatever case, spaces or dash the person used. The field
 * is a plain text field without it, and the server reads the same code.
 */
import { formatDeviceCode } from "../device-code.js";

export function initDeviceCode(): void {
  for (const field of document.querySelectorAll<HTMLInputElement>(
    "input[data-device-code]",
  )) {
    const write = (): void => {
      const formatted = formatDeviceCode(field.value);
      if (formatted !== field.value) field.value = formatted;
    };
    write();
    field.addEventListener("input", write);
  }
}
