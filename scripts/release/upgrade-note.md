## Before you upgrade

Until the first public release, nothing upgrades a database in place. A build whose database schema differs from the one your instance holds refuses to start on it, changes nothing in the file, and says so in its log. The build that wrote the file can still read it, so going back to that build brings the instance back.

To carry your data into this build, take an export with the build that wrote the file (`GET /export?format=archive`), start this build on a fresh file, and restore the archive there (`POST /admin/restore-archive`). Until the first public release an archive is read only by the build that wrote it, so that restore can refuse the archive. Keep the export and the old build until the restore has answered.

In the container image, a refused database leaves the container running and unhealthy, with the message in its log, rather than restarting it into the same refusal. `deploy/README.md` says what to do next.
