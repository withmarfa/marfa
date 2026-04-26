import { createRoot } from "react-dom/client";
import { useState, useEffect } from "react";
import { MymeSyncClient } from "@mymehq/sync-client";
import {
  MymeSyncProvider,
  useItems,
  useMutation,
  useSyncState,
  usePendingMutations,
  useSyncEvents,
} from "@mymehq/sync-client/react";

interface MymeAuth {
  getApiKey(): string;
  getApiUrl(): string;
  hasCredentials(): boolean;
}

declare global {
  interface Window {
    mymeAuth: MymeAuth;
  }
}

async function bootstrap() {
  if (!window.mymeAuth.hasCredentials()) {
    throw new Error(
      "Set MYME_API_KEY and MYME_API_URL before launching the demo.",
    );
  }
  const client = new MymeSyncClient({
    apiUrl: window.mymeAuth.getApiUrl(),
    apiKey: window.mymeAuth.getApiKey(),
    storage: "idb:myme-sync-client-demo",
    source: "myme-demo",
    onAuthRevoked: () => {
      // Real app: surface re-auth prompt + clear keychain.
      console.warn("Auth revoked — please re-sign-in.");
    },
  });
  await client.start();
  return client;
}

function SyncIndicator() {
  const { state } = useSyncState();
  const { count } = usePendingMutations();
  const cls = `indicator ${state}`;
  return (
    <span className={cls}>
      {state}
      {count > 0 ? ` · ${count} pending` : ""}
    </span>
  );
}

function BlobOfflineToast() {
  const { latest } = useSyncEvents("mutation.rejected");
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    setDismissed(null);
  }, [latest]);
  if (!latest || latest.id === dismissed) return null;
  if (latest.kind !== "createItem") return null;
  return (
    <div className="toast" onClick={() => setDismissed(latest.id)}>
      Local change rejected ({latest.error.code}). Click to dismiss.
    </div>
  );
}

function NoteList() {
  const { data, isLoading } = useItems("core.note", { state: "active", limit: 50 });
  const { mutate, isPending } = useMutation(async (client, body: string) => {
    return client.items.create({
      type: "core.note",
      properties: { body, title: body.slice(0, 40) },
    });
  });

  const [draft, setDraft] = useState("");

  if (isLoading) return <p>Loading…</p>;
  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New note…"
          style={{ flex: 1, padding: 8 }}
        />
        <button
          disabled={!draft || isPending}
          onClick={() => {
            void mutate(draft).then(() => setDraft(""));
          }}
        >
          Add
        </button>
      </div>
      {data.map((note) => {
        const props = note.properties as { body?: string; title?: string };
        return (
          <div key={note.id} className="item">
            <strong>{props.title}</strong>
            <div style={{ color: "#666" }}>{props.body}</div>
          </div>
        );
      })}
    </div>
  );
}

function App({ client }: { client: MymeSyncClient }) {
  return (
    <MymeSyncProvider client={client}>
      <header>
        <h1 style={{ flex: 1 }}>Myme demo</h1>
        <SyncIndicator />
      </header>
      <main>
        <NoteList />
      </main>
      <BlobOfflineToast />
    </MymeSyncProvider>
  );
}

void (async () => {
  const root = createRoot(document.getElementById("root")!);
  try {
    const client = await bootstrap();
    root.render(<App client={client} />);
  } catch (err) {
    root.render(
      <div style={{ padding: 32, color: "#b71c1c" }}>
        Demo failed to bootstrap: {(err as Error).message}
      </div>,
    );
  }
})();
