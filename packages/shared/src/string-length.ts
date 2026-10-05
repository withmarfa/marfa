import type { z } from "zod";

/** Preserve UTF-16 string bounds across Zod versions while retaining schema metadata. */
export function maxStringLength(schema: z.ZodString, max: number): z.ZodString {
  return schema.max(max).refine((value) => value.length <= max, {
    message: `Must contain at most ${String(max)} UTF-16 code units`,
  });
}

/** Preserve a UTF-16 minimum without changing its published schema bound. */
export function minStringLength(
  schema: z.ZodString,
  min: number,
  message: string,
): z.ZodString {
  return schema
    .refine((value) => value.length >= min, { message })
    .meta({ minLength: min });
}
