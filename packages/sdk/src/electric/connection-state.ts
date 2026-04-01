export type ConnectionState = "disconnected" | "connecting" | "syncing" | "connected" | "error";

export type ConnectionStateListener = (state: ConnectionState, error?: Error) => void;

const VALID_TRANSITIONS: Record<ConnectionState, ConnectionState[]> = {
  disconnected: ["connecting"],
  connecting: ["syncing", "error", "disconnected"],
  syncing: ["connected", "error", "disconnected"],
  connected: ["syncing", "error", "disconnected"],
  error: ["connecting", "disconnected"],
};

export class ConnectionStateManager {
  private state: ConnectionState = "disconnected";
  private listeners = new Set<ConnectionStateListener>();
  private lastError?: Error;

  get current(): ConnectionState {
    return this.state;
  }

  get error(): Error | undefined {
    return this.lastError;
  }

  transition(newState: ConnectionState, error?: Error): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(newState)) {
      console.warn(`ConnectionState: unexpected transition ${this.state} → ${newState}`);
    }

    this.state = newState;
    this.lastError = error;

    for (const listener of this.listeners) {
      try {
        listener(newState, error);
      } catch {
        // Don't let listener errors crash the state machine
      }
    }
  }

  subscribe(listener: ConnectionStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
