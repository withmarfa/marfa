# Archive version 4, written by v0.0.104

`marfa-0.0.104.tar` is the archive that the published v0.0.104 `marfa-server` for macOS (arm64) exported with `GET /export?format=archive&state=any`. It is frozen: never regenerate it, and add another release's archive beside it rather than replace it.

The release's server ran on a new data directory and was filled with example values, one of every entry and line kind the archive carries: a file with a blob, a note with two versions, tags and an extension, a trashed note, an item of a registered type, a conversation with a table row, two edges, a type, an edge type, a type icon, a source name, two settings, enforcement, a connector's state and agreement, an app vendor, and a plugin with its connector settings and mapping, which holds an open rewrite request.

`restore-release-archive.test.ts` restores it with every build.
