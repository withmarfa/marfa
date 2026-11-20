## Before you upgrade

Before Marfa 0.1, a newer release may not read an earlier release's database. `marfa update start` and `marfa server upgrade` move an install to this release when it can read the database. When it can't, the install stays on its release and the database stays as it was. A release that changes how the database is laid out keeps a copy of it first, as `marfa.db.before-upgrade` beside it.

Note the release your instance runs: `marfa server status` shows it, and so does `version` in the JSON that `GET /` answers. On a native install, `marfa server upgrade` asks the newer `marfa-server` first and changes nothing when it refuses the database; the programs you installed are still the newer ones, so install the earlier release again, as the command's message shows. On a Docker install, the command starts the earlier release again.

When this release can't read your database, move by export and restore: export the data while your release runs, make a new install of this release in another `--dir`, and restore the archive there. A restore refuses an archive whose `manifest.json` names no format, which only releases before 0.0.72 wrote.

A release that refuses a database changes nothing in it, says in its log why it refused, and exits with status 78. `marfa server run`, which every install starts, then stays up without the server, so nothing restarts it into the same refusal. To go back, install the release that wrote the database again, then run `marfa server start`. The "Upgrade" section of `deploy/README.md` has the detail.
