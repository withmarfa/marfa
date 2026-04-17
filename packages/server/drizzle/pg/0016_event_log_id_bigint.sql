-- Widen event_log.id from INT4 to BIGINT.
--
-- Initial migration 0000 created event_log.id as INT4 (max 2,147,483,647).
-- event_log is append-only, so INT4 is a foreseeable wrap; the bootstrap
-- DDL in pg/connection.ts was already correct (BIGINT). This aligns the
-- migrated path with the bootstrap path.
--
-- The Postgres rewrite of an integer column to bigint is a full table
-- rewrite. event_log is bounded (24-hour retention by default — see
-- runEventLogCleanup in src/index.ts), so the rewrite is fast on
-- practical deployments.
--
-- The IDENTITY sequence is implicitly bigint underneath, but its
-- MAXVALUE was set from the original column type at creation. Widen
-- the cap so newly-allocated values are not clipped at 2^31-1.

ALTER TABLE event_log ALTER COLUMN id TYPE BIGINT;
ALTER SEQUENCE event_log_id_seq MAXVALUE 9223372036854775807;
