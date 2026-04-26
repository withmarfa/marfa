import { createContext, useContext, type ReactElement, type ReactNode } from "react";
import type { MymeSyncClient } from "../client.js";

const MymeSyncContext = createContext<MymeSyncClient | null>(null);

export interface MymeSyncProviderProps {
  client: MymeSyncClient;
  children: ReactNode;
}

/**
 * React context provider. Place at the root of your app:
 *
 *   <MymeSyncProvider client={client}>
 *     <App />
 *   </MymeSyncProvider>
 */
export function MymeSyncProvider({
  client,
  children,
}: MymeSyncProviderProps): ReactElement {
  return (
    <MymeSyncContext.Provider value={client}>
      {children}
    </MymeSyncContext.Provider>
  );
}

/**
 * Resolve the current `MymeSyncClient` from context. Throws when used
 * outside `MymeSyncProvider` — the message points at the wiring fix.
 */
export function useMymeSyncClient(): MymeSyncClient {
  const client = useContext(MymeSyncContext);
  if (!client) {
    throw new Error(
      "useMymeSyncClient: no MymeSyncProvider in the React tree. Wrap your app: <MymeSyncProvider client={client}>...</MymeSyncProvider>",
    );
  }
  return client;
}
