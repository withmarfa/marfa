import type {
  BulkActionJobLease,
  BulkActionJobRow,
} from "../storage/interface.js";
import type { BulkActionErrorEntry, BulkActionResult } from "./types.js";

export const RESPONSE_SAMPLE_CAP = 100;
export interface BulkActionSamples {
  ids: string[];
  errors: BulkActionErrorEntry[];
}
export class BulkActionLeaseLost extends Error {
  constructor() {
    super("The bulk job no longer belongs to this worker at this cursor");
    this.name = "BulkActionLeaseLost";
  }
}
export function jobLease(job: BulkActionJobRow): BulkActionJobLease {
  if (!job.worker_id) throw new BulkActionLeaseLost();
  return {
    jobId: job.id,
    workerId: job.worker_id,
    generation: job.claim_generation,
  };
}
export function ownsJob(
  job: BulkActionJobRow | null,
  lease: BulkActionJobLease,
): job is BulkActionJobRow {
  return (
    job?.status === "in_progress" &&
    job.worker_id === lease.workerId &&
    job.claim_generation === lease.generation
  );
}
export function summarizeJob(job: BulkActionJobRow): BulkActionResult {
  const samples = JSON.parse(job.checkpoint_json) as BulkActionSamples;
  return {
    action: job.action,
    matched: job.matched_count,
    succeeded: job.succeeded_count,
    errored: job.errored_count,
    dry_run: false,
    ...(job.succeeded_count > 0 && job.succeeded_count <= RESPONSE_SAMPLE_CAP
      ? { ids: samples.ids }
      : {}),
    ...(job.errored_count > 0 ? { errors: samples.errors } : {}),
    ...(job.action === "purge"
      ? { blob_hashes_referenced: job.blob_hashes_referenced_count }
      : {}),
  };
}
