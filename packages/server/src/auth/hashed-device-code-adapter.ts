/**
 * Device codes are stored as their digest, as access and refresh tokens are.
 *
 * A device code is a bearer secret: whoever holds it when the person approves
 * is handed the tokens. The device-authorization plugin offers no hook for
 * storing it hashed, so this wrapper does it at the adapter, which is the one
 * place every read and write of the `deviceCode` model passes: a value
 * written to the `deviceCode` field, and a value a lookup matches that field
 * against, become the digest. The plugin answers the device with the code it
 * generated, never with the stored row, and finds the row only by matching
 * this field, so nothing it does sees the difference. Marfa's own readers
 * (`findDeviceCodeGrantKey`, `findDeviceCodeRequest`) take the digest too.
 */

/** The model name Better Auth maps to `auth_oauth_device_code`. */
const DEVICE_CODE_MODEL = "deviceCode";
/** The field holding the code. */
const DEVICE_CODE_FIELD = "deviceCode";

interface Where {
  field: string;
  value: unknown;
  [key: string]: unknown;
}

interface AdapterArgs {
  model: string;
  data?: Record<string, unknown>;
  update?: Record<string, unknown>;
  where?: Where[];
  [key: string]: unknown;
}

type Operation = (args: AdapterArgs) => Promise<unknown>;

const operations = [
  "create",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "consumeOne",
  "incrementOne",
  "findOne",
  "findMany",
  "count",
] as const;

/** Wrap the factory returned by `drizzleAdapter(...)`; every other model and
 *  method delegates untouched. */
export function withHashedDeviceCodes<
  Factory extends (options: never) => unknown,
>(factory: Factory, hash: (code: string) => string): Factory {
  const digest = (value: unknown): unknown =>
    typeof value === "string"
      ? hash(value)
      : Array.isArray(value)
        ? value.map(digest)
        : value;
  const withDigest = (
    record: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined =>
    record && DEVICE_CODE_FIELD in record
      ? { ...record, [DEVICE_CODE_FIELD]: digest(record[DEVICE_CODE_FIELD]) }
      : record;

  return ((options: never) => {
    const adapter = factory(options) as Record<string, unknown>;
    const wrapped: Record<string, unknown> = { ...adapter };
    for (const operation of operations) {
      const original = adapter[operation];
      if (typeof original !== "function") continue;
      wrapped[operation] = (args: AdapterArgs) => {
        if (args.model !== DEVICE_CODE_MODEL)
          return (original as Operation).call(adapter, args);
        return (original as Operation).call(adapter, {
          ...args,
          ...(args.data ? { data: withDigest(args.data) } : {}),
          ...(args.update ? { update: withDigest(args.update) } : {}),
          ...(args.where
            ? {
                where: args.where.map((clause) =>
                  clause.field === DEVICE_CODE_FIELD
                    ? { ...clause, value: digest(clause.value) }
                    : clause,
                ),
              }
            : {}),
        });
      };
    }
    return wrapped;
  }) as Factory;
}
