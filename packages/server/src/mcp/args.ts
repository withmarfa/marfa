/**
 * Tool arguments that become a segment of an API path. A request's URL is
 * resolved before it is dispatched, so a segment of `.` or `..` would name
 * another operation; each is refused here, before any request is built.
 */
import { isValidId } from "@withmarfa/shared";
import * as z from "zod";

/** An item's or a view's ID. */
export const itemId = z
  .string()
  .refine(isValidId, { message: "Not an ID: an ID is a UUIDv7." });

/** A value, such as a type or a tag, sent as one path segment. */
export const pathSegment = z
  .string()
  .min(1)
  .refine((value) => value !== "." && value !== "..", {
    message: "`.` and `..` name no type or tag.",
  });
