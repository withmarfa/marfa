import { useCallback, useState } from "react";
import type { MymeSyncClient } from "../client.js";
import { useMymeSyncClient } from "./provider.js";

export interface UseMutationResult<TArgs, TResult> {
  mutate: (args: TArgs) => Promise<TResult>;
  isPending: boolean;
  error: Error | null;
  reset: () => void;
}

/**
 * Wraps an async function as a React-friendly mutation handler. Tracks
 * `isPending` and `error` state for the most recent call. Repeated
 * calls overwrite the in-flight state — useful for "save" buttons that
 * the user might click multiple times.
 */
export function useMutation<TArgs, TResult>(
  fn: (client: MymeSyncClient, args: TArgs) => Promise<TResult>,
): UseMutationResult<TArgs, TResult> {
  const client = useMymeSyncClient();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const mutate = useCallback(
    async (args: TArgs): Promise<TResult> => {
      setIsPending(true);
      setError(null);
      try {
        const result = await fn(client, args);
        setIsPending(false);
        return result;
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        setError(e);
        setIsPending(false);
        throw e;
      }
    },
    [client, fn],
  );

  const reset = useCallback(() => {
    setIsPending(false);
    setError(null);
  }, []);

  return { mutate, isPending, error, reset };
}
