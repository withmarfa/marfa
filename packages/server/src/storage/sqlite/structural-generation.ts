import type { Client, Transaction } from "@libsql/client";

export const STRUCTURAL_GENERATION_KEY = "read_view.structural_generation";
const MAX_GENERATION = 9_223_372_036_854_775_807n;

export function structuralGeneration(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    value.length > 19 ||
    BigInt(value) > MAX_GENERATION
  )
    throw new Error("Stored structural generation is unavailable");
  return value;
}

export async function loadStructuralGeneration(
  reader: Pick<Client | Transaction, "execute">,
): Promise<string> {
  const result = await reader.execute({
    sql: "SELECT value FROM settings WHERE key = ?",
    args: [STRUCTURAL_GENERATION_KEY],
  });
  return structuralGeneration(result.rows[0]?.value);
}

export async function initializeStructuralGeneration(
  client: Client,
): Promise<void> {
  await client.execute({
    sql: "INSERT INTO settings (key, value) VALUES (?, '0') ON CONFLICT (key) DO NOTHING",
    args: [STRUCTURAL_GENERATION_KEY],
  });
  await loadStructuralGeneration(client);
}

export async function advanceStructuralGeneration(
  writer: Client,
): Promise<void> {
  const previous = await loadStructuralGeneration(writer);
  const next = BigInt(previous) + 1n;
  if (next > MAX_GENERATION)
    throw new Error("Stored structural generation is exhausted");
  const result = await writer.execute({
    sql: "UPDATE settings SET value = ? WHERE key = ? AND value = ? RETURNING value",
    args: [next.toString(), STRUCTURAL_GENERATION_KEY, previous],
  });
  if (result.rows.length !== 1 || result.rows[0]?.value !== next.toString())
    throw new Error("Stored structural generation could not advance");
}
