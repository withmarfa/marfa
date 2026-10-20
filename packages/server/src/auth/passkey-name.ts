import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { DisplayNameSchema } from "../display-name.js";

/**
 * The name of a passkey, the one rule at both doors that take it: the rename
 * (`authentication/passkey-rename`) and the registration that stores it
 * (`authentication/passkey-registration-name`).
 */
export const PasskeyNameSchema = DisplayNameSchema.describe(
  "The passkey's name. Marfa trims spaces from each end.",
);

/**
 * Refuse a registration whose `name` breaks {@link PasskeyNameSchema}, from a
 * copy of the body, before the passkey plugin stores anything. A registration
 * without a `name` is left to the plugin, which stores the passkey unnamed.
 */
export async function requirePasskeyName(request: Request): Promise<void> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  if (typeof body !== "object" || body === null || !("name" in body)) return;
  if (body.name === undefined) return;
  if (!PasskeyNameSchema.safeParse(body.name).success)
    throw new MarfaError(
      ErrorCode.VALIDATION_ERROR,
      "name must be 1 to 200 characters, with no control or bidirectional formatting characters.",
    );
}
