## Before you upgrade

When this build's database schema is newer than the one your instance holds, it updates the database in place at its first start. Before it changes anything, it copies the database to a file beside it named `marfa.db.backup-schema-<from>-to-<to>-<time>`, and it keeps that copy until you remove it. The update is one transaction: if it fails its checks or the server is stopped partway, the database stays as it was. The server's log names the copy.

This build refuses a database that a newer build wrote, one whose shape matches no earlier build's schema, and one it cannot update, such as when the disk has less than twice the database's size free. It changes nothing in a refused file and says why in its log.

To go back, start the earlier build on the copy, not on the updated database, which it may refuse or read without knowing what the update changed. Stop the instance, delete `marfa.db-wal` and `marfa.db-shm` (SQLite applies a log it finds beside a database file, even when the log belongs to a newer state), replace `marfa.db` with the copy, and start the earlier build. With a bucket, start the copy under a new `S3_PREFIX`, because it is older than the bucket's copy.

In the container image, a refused database leaves the container running and unhealthy, with the message in its log, rather than restarting it into the same refusal. The "Upgrading" section of `deploy/README.md` says what to do next.
