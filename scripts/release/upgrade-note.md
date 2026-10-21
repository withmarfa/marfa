## Before you upgrade

Until the first public release, nothing upgrades a database in place. A build whose database schema differs from the one your instance holds refuses to start on it, changes nothing in the file, and says so in its log. The build that wrote the file can still read it, so going back to that build brings the instance back.

To try carrying your data into this build, take an export with the build that wrote the file (`GET /export?format=archive&state=any`), start this build on a fresh file, and restore the archive there (`POST /restore`). The `state=any` parameter includes trashed items. Until the first public release, archive compatibility is guaranteed only for the build that wrote the archive. Another build can refuse it, and a successful restore does not guarantee that every field from the original database was preserved. Keep the original database, its build, and the export so you can return to the original instance.

In the container image, a refused database leaves the container running and unhealthy, with the message in its log, rather than restarting it into the same refusal. `deploy/README.md` says what to do next.
