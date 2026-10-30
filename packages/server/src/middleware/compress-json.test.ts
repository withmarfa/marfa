import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ErrorCode, MarfaError } from "@withmarfa/shared";
import { compressJson } from "./compress-json.js";
import { createErrorHandler } from "./error-handler.js";
import type { AppEnv } from "./auth.js";

const page = {
  data: Array.from({ length: 200 }, (_, i) => ({
    id: i,
    body: "a note ".repeat(40),
  })),
};

describe("JSON compression", () => {
  const app = new Hono<AppEnv>();
  app.onError(createErrorHandler({ errorWebhookUrl: "" }));
  app.use("*", compressJson());
  app.get("/page", (c) => c.json(page));
  app.get("/problem", (c) =>
    c.body(JSON.stringify(page), 200, {
      "Content-Type": "application/problem+json",
    }),
  );
  app.get("/refused", () => {
    throw new MarfaError(ErrorCode.NOT_FOUND, "x".repeat(4096));
  });
  app.post("/page", (c) => c.json(page));
  app.get("/stream", (c) =>
    c.body("data: " + "x".repeat(4096) + "\n\n", 200, {
      "Content-Type": "text/event-stream",
    }),
  );
  app.get("/lines", (c) =>
    c.body(JSON.stringify(page) + "\n", 200, {
      "Content-Type": "application/x-ndjson",
    }),
  );

  const request = (path: string, headers: Record<string, string>) =>
    app.fetch(new Request(`http://h${path}`, { headers }));
  const bearer = { Authorization: "Bearer k", "Accept-Encoding": "gzip, br" };

  it("gzips a JSON answer to a request with a credential", async () => {
    const response = await request("/page", bearer);
    expect(response.headers.get("Content-Encoding")).toBe("gzip");
    expect(response.headers.get("Vary")).toContain("Accept-Encoding");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBeLessThan(JSON.stringify(page).length / 4);
    expect(JSON.parse(gunzipSync(bytes).toString("utf8"))).toEqual(page);
  });

  it("gzips a +json answer and a refusal", async () => {
    for (const path of ["/problem", "/refused"]) {
      const response = await request(path, bearer);
      expect(response.headers.get("Content-Encoding"), path).toBe("gzip");
      JSON.parse(
        gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8"),
      );
    }
  });

  it("answers as it is to a request without a credential", async () => {
    const witness = await request("/page", bearer);
    expect(witness.headers.get("Content-Encoding")).toBe("gzip");
    const response = await request("/page", {
      Cookie: "session=s",
      "Accept-Encoding": "gzip",
    });
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(await response.json()).toEqual(page);
  });

  it("answers as it is to a request that does not accept gzip", async () => {
    const refusing: Record<string, string>[] = [
      { Authorization: "Bearer k" },
      { Authorization: "Bearer k", "Accept-Encoding": "br, gzip;q=0" },
    ];
    for (const headers of refusing) {
      const response = await request("/page", headers);
      expect(response.headers.get("Content-Encoding")).toBeNull();
      expect(await response.json()).toEqual(page);
    }
  });

  it("answers as it is to a request other than GET", async () => {
    const witness = await request("/page", bearer);
    expect(witness.headers.get("Content-Encoding")).toBe("gzip");
    const response = await app.fetch(
      new Request("http://h/page", {
        method: "POST",
        headers: { ...bearer, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(await response.json()).toEqual(page);
  });

  it("leaves an event stream and other types alone", async () => {
    for (const path of ["/stream", "/lines"]) {
      const response = await request(path, bearer);
      expect(response.headers.get("Content-Encoding"), path).toBeNull();
    }
  });
});
