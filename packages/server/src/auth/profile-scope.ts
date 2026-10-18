import { APIError } from "better-auth/api";

/** Email writes are never an app permission, even in old provider records. */
export function containsProfileEmailWrite(scopes: unknown): boolean {
  const values =
    typeof scopes === "string"
      ? scopes.split(/\s+/)
      : Array.isArray(scopes)
        ? scopes
        : [];
  return values.includes("profile.email:write");
}

export function refuseProfileEmailWrite(scopes: unknown): void {
  if (containsProfileEmailWrite(scopes))
    throw new APIError("BAD_REQUEST", {
      error: "invalid_scope",
      error_description: "Only the owner can change the sign-in email address.",
    });
}
