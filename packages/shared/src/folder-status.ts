import type { VersionWriter } from "./types.js";
export const FOLDER_PROBLEM_CODES = [
  "conflict",
  "refused",
  "credential_refused",
  "unreadable",
  "held_file",
  "unavailable",
  "root_gone",
  "settings_invalid",
] as const;
export type FolderProblemCode = (typeof FOLDER_PROBLEM_CODES)[number];
export interface FolderProblem {
  code: FolderProblemCode;
  count: number;
}
export interface FolderStatusReport {
  folder_store_id: string;
  sequence: number;
  last_success_at: string | null;
  pending_uploads: number;
  pending_downloads: number;
  paused_removals: number;
  first_sync_waiting: boolean;
  problems: FolderProblem[];
}
export interface FolderStatusAck {
  accepted: boolean;
  sequence: number;
  received_at: string;
}
export const FOLDER_STATUS_SIGN_IN_KINDS = ["browser", "app", "key"] as const;

export type FolderStatusSignIn = Omit<VersionWriter, "kind"> & {
  kind: (typeof FOLDER_STATUS_SIGN_IN_KINDS)[number];
};
export interface StoredFolderStatus extends FolderStatusReport {
  sign_in: FolderStatusSignIn;
  received_at: string;
}
export interface FolderStatusCopy extends FolderStatusReport {
  received_at: string;
  age_seconds: number;
}
export interface FolderStatusTotals {
  saturated: boolean;
  pending_uploads: number;
  pending_downloads: number;
  paused_removals: number;
  first_sync_waiting: number;
  problems: FolderProblem[];
}
export interface FolderStatus {
  folder_id: string;
  sign_ins: {
    sign_in: FolderStatusSignIn;
    current: boolean;
    copies: FolderStatusCopy[];
  }[];
  totals: FolderStatusTotals;
}
