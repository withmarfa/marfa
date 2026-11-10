import { describe, expect, it } from "vitest";
import { timedAnswer } from "./answer.js";

describe("timedAnswer", () => {
  it("answers the status and body of a response that completes", async () => {
    const answer = await timedAnswer(
      async () => new Response("{}", { status: 201 }),
    );
    expect(answer.status).toBe(201);
    expect(answer.json()).toEqual({});
  });

  it("answers status 0 when the body breaks off after a 200 header", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new Error("connection reset"));
      },
    });
    const answer = await timedAnswer(
      async () => new Response(body, { status: 200 }),
    );
    expect(answer.status).toBe(0);
    expect(answer.text).toMatch(/connection reset/);
  });

  it("answers status 0 when the call fails", async () => {
    const answer = await timedAnswer(async () => {
      throw new Error("refused");
    });
    expect(answer.status).toBe(0);
  });
});
