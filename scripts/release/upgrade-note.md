## Before you upgrade

Note the release your instance runs: `marfa server status` shows it, and so does `version` in the JSON that `GET /` answers. Keep a backup or an export from that release, because the server keeps only one copy of the database from before an upgrade.

When this release's database schema is newer than the one your instance holds, the server updates the database in place at its first start, in one transaction. If the update fails or the server stops partway, the database stays as it was.

Before it changes a database that holds data, the server copies it to `marfa.db.before-upgrade` beside it, in place of the copy from any earlier upgrade, and its log records the copy's path. The copy needs as much free disk as the data in the database, plus the disk reserve (the `disk_reserve_bytes` setting, 128 MiB unless your instance sets another). If less is free, or the copy can't be written, the server changes nothing and exits with status 1. The service manager or Docker then starts it again, and it refuses the same way until there's room.

The server also refuses a database that a newer release wrote, and one whose schema matches none it knows. It changes nothing in that database, says in its log why it refused and what to do, and exits with status 78. `marfa server run`, which every install starts, then stays up without the server, so nothing restarts it into the same refusal.

To go back after an upgrade, stop the server, delete `marfa.db-wal` and `marfa.db-shm`, replace `marfa.db` with `marfa.db.before-upgrade`, and start the earlier release. Delete the two files first because SQLite applies a log it finds beside a database file. Writes made since the upgrade aren't in the copy. The "Upgrade" section of `deploy/README.md` gives the commands.
