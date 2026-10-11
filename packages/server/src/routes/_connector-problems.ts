import { z } from "@hono/zod-openapi";
import { maxStringLength } from "@withmarfa/shared";

export const MAX_PROBLEMS_BYTES = 512 * 1024;
export const MAX_PROBLEMS = 200;
export const MAX_PROBLEM_LENGTH = 500;

export const ConnectorProblemsSchema = z
  .record(z.string(), maxStringLength(z.string(), MAX_PROBLEM_LENGTH))
  .describe(
    "The source's current problems, by opaque key. Each message is at most 500 UTF-16 code units. The map has at most 200 entries and 512 KiB serialized as UTF-8. An empty map means no current problems.",
  )
  .openapi("ConnectorProblems");
