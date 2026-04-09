# Log rotation

The Myme server logs to stderr, which launchd redirects to log files. Without rotation, these files grow unbounded.

## macOS (newsyslog)

macOS includes `newsyslog` for log rotation. Create a config file:

```bash
sudo nano /etc/newsyslog.d/myme.conf
```

Contents:

```
# logfilename                                    [owner:group]  mode  count  size  when  flags
/Users/<operator>/Services/myme/stderr.log                       644   7      1024  *     J
/Users/<operator>/Services/myme-staging/stderr.log               644   7      1024  *     J
```

Replace `<operator>` with the actual username on the server.

Fields:
- **mode**: file permissions after rotation
- **count**: number of rotated files to keep (7 = one week of daily rotations)
- **size**: rotate when file exceeds this size in KB (1024 = 1 MB)
- **when**: time-based rotation (`*` = use size-based only; `$D0` = daily at midnight)
- **flags**: `J` = compress rotated files with bzip2

## Verify

Test the configuration:

```bash
sudo newsyslog -nv
```

The `-n` flag does a dry run. Remove `-n` to execute.

## Notes

- Myme logs structured JSON (one entry per line), so rotated files remain parseable with `jq`
- The server does not need to be restarted after rotation — it writes to stdout/stderr, and launchd handles the file descriptors
- For real-time log analysis: `tail -f ~/Services/myme/stderr.log | jq .`
