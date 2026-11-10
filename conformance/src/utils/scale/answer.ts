export interface TimedAnswer {
  status: number;
  /** Milliseconds from starting the call to the whole body read. */
  ms: number;
  text: string;
  json: () => unknown;
}

/**
 * Times one request through to the end of its body. Status 0 means the
 * request did not complete: a refused connection, a timeout, or a body that
 * broke off, whatever status the headers carried.
 */
export async function timedAnswer(
  call: () => Promise<Response>,
): Promise<TimedAnswer> {
  const start = performance.now();
  let status = 0;
  let text = "";
  try {
    const response = await call();
    const body = await response.text();
    status = response.status;
    text = body;
  } catch (error) {
    text = String(error);
  }
  return {
    status,
    ms: performance.now() - start,
    text,
    json: () => JSON.parse(text) as unknown,
  };
}
