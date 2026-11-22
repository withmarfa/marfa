import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A provider's token address on this machine, which a `sign-in-provider`
 * fault points a connector's sign-in at, so no sign-in leaves the machine.
 */

export type Asked = {
  method: string;
  path: string;
  contentType: string | undefined;
  form: URLSearchParams;
};

export type Answer = { status: number; body: unknown; delayMs?: number };

export type Provider = {
  origin: string;
  /** Each request the provider was sent, in order. */
  asked: Asked[];
  /** How the provider answers the next request; a test sets it. */
  answer: (asked: Asked) => Answer;
  close(): Promise<void>;
};

let tokens = 0;

/** A token answer Google gives, each with a refresh token no other answer gave. */
export function granted(): Answer {
  tokens += 1;
  return {
    status: 200,
    body: {
      access_token: `access-${String(tokens)}-${randomUUID()}`,
      refresh_token: `1//refresh-${String(tokens)}-${randomUUID()}`,
      expires_in: 3599,
      token_type: "Bearer",
    },
  };
}

function read(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    let text = "";
    request.on("data", (part: Buffer) => (text += part.toString("utf8")));
    request.on("end", () => done(text));
  });
}

export async function runProvider(): Promise<Provider> {
  const made: Provider = {
    origin: "",
    asked: [],
    answer: granted,
    close: async () => {},
  };
  const listening = createServer((request, response) => {
    void read(request).then((text) => {
      const asked: Asked = {
        method: request.method ?? "",
        path: request.url ?? "",
        contentType: request.headers["content-type"],
        form: new URLSearchParams(text),
      };
      made.asked.push(asked);
      const answer = made.answer(asked);
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(answer.status, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify(answer.body));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((done) =>
    listening.listen(0, "127.0.0.1", () => done()),
  );
  const port = (listening.address() as AddressInfo).port;
  made.origin = `http://127.0.0.1:${String(port)}`;
  made.close = () =>
    new Promise((done) => {
      listening.closeAllConnections();
      listening.close(() => done());
    });
  return made;
}

/** The owner's browser arriving at the callback, as a provider sends it. */
export async function arriveAt(
  apiUrl: string,
  query: Record<string, string>,
): Promise<{
  status: number;
  location: string | null;
  policy: string | null;
  contentType: string | null;
  text: string;
}> {
  const answer = await fetch(
    `${apiUrl}/connect/oauth/callback?${new URLSearchParams(query).toString()}`,
    { redirect: "manual", headers: { accept: "text/html" } },
  );
  return {
    status: answer.status,
    location: answer.headers.get("location"),
    policy: answer.headers.get("content-security-policy"),
    contentType: answer.headers.get("content-type"),
    text: await answer.text(),
  };
}
