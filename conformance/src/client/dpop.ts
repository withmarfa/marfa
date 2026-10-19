import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { MarfaClientOptions } from "./api.js";

export class DpopClient {
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "P-256" });

  constructor(
    private readonly options: Pick<
      MarfaClientOptions,
      "serverClockOffsetMs"
    > = {},
  ) {}

  proof(method: string, url: string, accessToken?: string): string {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const offset = this.options.serverClockOffsetMs ?? 0;
    const now = Date.now() + (typeof offset === "number" ? offset : offset());
    const target = new URL(url);
    target.search = "";
    target.hash = "";
    const input = `${encode({
      alg: "ES256",
      typ: "dpop+jwt",
      jwk: this.keys.publicKey.export({ format: "jwk" }),
    })}.${encode({
      jti: randomUUID(),
      htm: method.toUpperCase(),
      htu: target.href,
      iat: Math.floor(now / 1000),
      ...(accessToken === undefined
        ? {}
        : {
            ath: createHash("sha256").update(accessToken).digest("base64url"),
          }),
    })}`;
    return `${input}.${sign("sha256", Buffer.from(input), {
      key: this.keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url")}`;
  }
}
