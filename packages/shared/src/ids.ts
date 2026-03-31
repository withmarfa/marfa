import { uuidv7 } from "uuidv7";

// UUIDv7 format: xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
// 36 characters with hyphens, version nibble = 7, variant bits = 10xx.
const UUIDV7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Generates a new UUIDv7 identifier (time-sortable, globally unique). */
export function generateId(): string {
  return uuidv7();
}

/** Returns true if the value is a valid UUIDv7 string. */
export function isValidId(value: string): boolean {
  return UUIDV7_PATTERN.test(value);
}
