## Before you upgrade

When this build's database schema is newer than the one your instance holds, it updates the database in place at its first start. Before it changes anything, it copies the database to a file beside it named `marfa.db.schema-<from>-to-<to>.bak`, and it keeps that copy until you remove it. The update is one transaction: if it fails its checks or the server is stopped partway, the database stays as it was. The server's log names the copy.

This build refuses a database that a newer build wrote, one whose shape matches no schema it knows, and one it cannot update, such as when its volume has less than twice the database's size free. It changes nothing in a refused file, says why in its log, and stops with status 78. `marfa server run`, which every install starts, then stays up without the server, so that nothing restarts it into the same refusal.

To go back, start the earlier build on the copy, not on the updated database. Stop the instance, delete `marfa.db-wal` and `marfa.db-shm` (SQLite applies a log it finds beside a database file, even when the log belongs to a newer state), replace `marfa.db` with the copy, and start the earlier build. The "Upgrade" section of `deploy/README.md` says more.
