import type {
  FolderStatus,
  FolderStatusTotals,
  FolderStatusSignIn,
} from "@withmarfa/shared";
import type { Storage } from "./storage/interface.js";
import { resolveLiveGrant } from "./auth/live-credential.js";
import * as clock from "./clock.js";

async function signInCurrent(
  storage: Storage,
  signIn: FolderStatusSignIn,
  now: Date,
): Promise<boolean> {
  if (signIn.kind !== "app") return storage.folderStatus.isCurrent(signIn, now);
  const row = await storage.items.get(signIn.id);
  if (
    row?.type !== "system.connection" ||
    row.state !== "active" ||
    row.properties.kind !== "app" ||
    row.properties.status !== "active"
  )
    return false;
  const { client_id, user_id } = row.properties;
  return (
    typeof client_id === "string" &&
    typeof user_id === "string" &&
    (await resolveLiveGrant(storage, client_id, user_id)) !== null
  );
}

function sum(left: number, right: number, totals: FolderStatusTotals): number {
  if (right > Number.MAX_SAFE_INTEGER - left) {
    totals.saturated = true;
    return Number.MAX_SAFE_INTEGER;
  }
  return left + right;
}

/** Read inside the caller's transaction so sign-in standing and reports agree. */
export async function readFolderStatus(
  storage: Storage,
  id: string,
): Promise<FolderStatus> {
  const now = clock.now();
  const groups: FolderStatus["sign_ins"] = [];
  const totals: FolderStatusTotals = {
    saturated: false,
    pending_uploads: 0,
    pending_downloads: 0,
    paused_removals: 0,
    first_sync_waiting: 0,
    problems: [],
  };
  for (const row of await storage.folderStatus.list(id)) {
    const { sign_in, ...report } = row;
    let group = groups.find(
      (value) =>
        value.sign_in.kind === sign_in.kind && value.sign_in.id === sign_in.id,
    );
    if (!group) {
      group = {
        sign_in,
        current: await signInCurrent(storage, sign_in, now),
        copies: [],
      };
      groups.push(group);
    }
    group.copies.push({
      ...report,
      age_seconds: Math.max(
        0,
        Math.floor((now.getTime() - Date.parse(row.received_at)) / 1000),
      ),
    });
    if (!group.current) continue;
    for (const key of [
      "pending_uploads",
      "pending_downloads",
      "paused_removals",
    ] as const)
      totals[key] = sum(totals[key], report[key], totals);
    totals.first_sync_waiting = sum(
      totals.first_sync_waiting,
      Number(report.first_sync_waiting),
      totals,
    );
    for (const problem of report.problems) {
      const total = totals.problems.find(
        (value) => value.code === problem.code,
      );
      if (total) total.count = sum(total.count, problem.count, totals);
      else totals.problems.push({ ...problem });
    }
  }
  return { folder_id: id, sign_ins: groups, totals };
}
