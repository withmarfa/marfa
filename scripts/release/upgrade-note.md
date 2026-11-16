## Before you upgrade

Before Marfa 0.1, a release cannot read the database of another release, or an export or backup that another release wrote. This release is a new instance, not an upgrade of the one you run: don't move a running install to it.

Note the release your instance runs: `marfa server status` shows it, and so does `version` in the JSON that `GET /` answers. Keep that install on the release it was made with. To try this release, make a new install in another `--dir` with its own port. Your running instance and its data stay as they are.

A release that meets another release's database changes nothing in it, says in its log why it refused, and exits with status 78. `marfa server run`, which every install starts, then stays up without the server, so nothing restarts it into the same refusal. To go back, install the release that wrote the database again, then run `marfa server start`. The "Upgrade" section of `deploy/README.md` has the detail.
