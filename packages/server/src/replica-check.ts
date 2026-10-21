/**
 * The image's check, before replication starts, that the database on the
 * volume is not older than its replica in the bucket.
 *
 * `deploy/entrypoint.sh` runs it when the volume already held a database,
 * as `node dist/replica-check.js <SQLITE_PATH> <S3_BUCKET> <S3_PREFIX>`,
 * with the replica's files as `litestream ltx -level all -json` lists them
 * on standard input. It exits 0 when replication may start, printing `empty`
 * when the replica holds nothing, and 1 with the reason and what to do on
 * standard error when it may not.
 * `storage/sqlite/replica-position.ts` says how it decides.
 */
import { readFileSync } from "node:fs";
import { errorMessage } from "./error-text.js";
import {
  checkReplica,
  refusalMessage,
  replicaTxid,
} from "./storage/sqlite/replica-position.js";

const [sqlitePath, bucket, prefix] = process.argv.slice(2);
if (sqlitePath === undefined || bucket === undefined || prefix === undefined) {
  process.stderr.write(
    "usage: replica-check <SQLITE_PATH> <S3_BUCKET> <S3_PREFIX>, with the replica listing on standard input\n",
  );
  process.exit(2);
}

let replica: bigint;
let verdict: ReturnType<typeof checkReplica>;
try {
  replica = replicaTxid(readFileSync(0, "utf8"));
  verdict = checkReplica(sqlitePath, replica);
} catch (error) {
  process.stderr.write(
    `Could not compare the database at ${sqlitePath} with the replica at ${prefix}/db in the bucket ${bucket}: ${errorMessage(error)}. Replication has not started, and the bucket is unchanged. To start without the check, start once with MARFA_REPLACE_NEWER_REPLICA=true: a database older than the replica then becomes its newest state.\n`,
  );
  process.exit(1);
}
if (!verdict.start) {
  process.stderr.write(
    `${refusalMessage(verdict, { sqlitePath, bucket, prefix })}\n`,
  );
  process.exit(1);
}
if (replica === 0n) process.stdout.write("empty\n");
