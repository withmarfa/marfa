# Directory-backed folder storage

Folder storage extends the pinned bundled SQLite Unix VFS. The build checks the amalgamation's digest before changing the Unix pathname operations. The native pager, inode lock registry, byte-range locks, WAL mapping, and synchronization remain SQLite's implementation.

Each registration retains a directory descriptor. Synthetic filenames select that registration and an entry name; they are not operating-system paths. Native files and shared-memory nodes retain the registration until their last close. Ordinary connections continue to use the native VFS and share its lock registry.

The directory VFS supports one persistent database per connection. Persistent `ATTACH` is refused; SQLite's temporary attachment for `VACUUM` remains supported. Temporary files are created in the retained directory. Lock-proxy controls are refused because their additional path operations are outside the directory capability.

Folder admission must check filesystem support before creating state. Apple platforms support APFS, HFS, UFS, FAT and exFAT, using SQLite’s native filesystem locking selection against the opened file. Linux keeps the native POSIX locking mode and refuses known NFS and SMB filesystems. Other platforms are refused. SQLite build options that remove WAL, change the OS implementation, move shared memory elsewhere, or change threading are also refused.

The extension symbol and all SQLite exports are compiled in one translation unit. The Rust registration call forces that object into the link; another SQLite runtime would cause duplicate-symbol errors.

The storage boundary is required by a constructor failure: replacing the root after directory admission but before the original store opened created `core.sqlite`, its writer lock, and settings in the replacement tree. The original cache also deleted a replacement blob when `let_go` ran after the root changed. Tests of an already-open original store's ordinary writes and close passed; those passing cases do not justify this extension.

Database identity probes use directory-relative `statat`, never an extra database open. Closing any additional descriptor for the same inode can release process-wide POSIX locks that SQLite still considers held. `identity_checks_do_not_release_native_database_locks` observes this with a separate native connection: it must remain blocked through identity probes and succeed only after rollback. Injecting an extra open and close into the probe makes that regression test fail.
