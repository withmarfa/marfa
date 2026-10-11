import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

/** A software authenticator: signed WebAuthn messages without an OS credential store. */
export function testAuthenticator() {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = keys.publicKey.export({ format: "jwk" });
  if (!jwk.x || !jwk.y)
    throw new Error("Test public key lacks curve coordinates");
  const x = jwk.x,
    y = jwk.y;
  const id = randomBytes(32);
  const sha = (value: string | Buffer) =>
    createHash("sha256").update(value).digest();
  const data = (challenge: string, origin: string, type: string) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  const header = (rpID: string, flags: number, counter: number) => {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    return Buffer.concat([sha(rpID), Buffer.from([flags]), count]);
  };
  return {
    id: id.toString("base64url"),
    registration(
      challenge: string,
      origin: string,
      rpID = "localhost",
      verified = true,
    ) {
      const publicKey = cbor(
        new Map<unknown, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(x, "base64url")],
          [-3, Buffer.from(y, "base64url")],
        ]),
      );
      const length = Buffer.alloc(2);
      length.writeUInt16BE(id.length);
      const authData = Buffer.concat([
        header(rpID, verified ? 0x45 : 0x41, 0),
        Buffer.alloc(16),
        length,
        id,
        publicKey,
      ]);
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: data(challenge, origin, "webauthn.create").toString(
            "base64url",
          ),
          attestationObject: cbor(
            new Map<unknown, unknown>([
              ["fmt", "none"],
              ["attStmt", new Map()],
              ["authData", authData],
            ]),
          ).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authentication(
      challenge: string,
      origin: string,
      counter = 1,
      rpID = "localhost",
      verified = true,
    ) {
      const client = data(challenge, origin, "webauthn.get");
      const authenticator = header(rpID, verified ? 5 : 1, counter);
      return {
        id: id.toString("base64url"),
        rawId: id.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: authenticator.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([authenticator, sha(client)]),
            keys.privateKey,
          ).toString("base64url"),
          userHandle: null,
        },
      };
    },
  };
}

function cbor(value: unknown): Buffer {
  const head = (major: number, length: number) =>
    length < 24
      ? Buffer.from([(major << 5) | length])
      : length < 256
        ? Buffer.from([(major << 5) | 24, length])
        : Buffer.from([(major << 5) | 25, length >> 8, length & 255]);
  if (typeof value === "number")
    return head(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map)
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([key, item]) => [cbor(key), cbor(item)]),
    ]);
  throw new Error("Unsupported test CBOR value");
}
