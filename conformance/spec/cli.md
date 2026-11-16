# The command line

The CLI is the `marfa` program. This chapter holds what only it does. A folder command's rules sit in the `folder-` chapters with the folder behavior they belong to.

## Profiles

A profile is a section of `profiles.toml`, a file a person writes by hand, that names a server and where its key comes from. It is not the owner's profile (`GLOSSARY.md`).

### `cli/profile-file-place`

The CLI MUST read profiles from `Library/Application Support/Marfa/profiles.toml` under `HOME` on macOS, and elsewhere from `marfa/profiles.toml` under `XDG_CONFIG_HOME`, or under `HOME/.config` where `XDG_CONFIG_HOME` is not set.

**Tests:** `cli/profiles.test.ts › takes the server and key from --profile, reading none of the variables`.

### `cli/profile-flag-first`

When `--profile NAME` is given, the CLI MUST take the server and the key from that profile and read none of `MARFA_API_URL`, `MARFA_API_KEY` and `MARFA_PROFILE`.

**Reason:** a profile named on the command line is the most specific choice, and a variable exported for another server must neither redirect it nor lend it a key.

**Tests:** `cli/profiles.test.ts › takes the server and key from --profile, reading none of the variables`.

### `cli/profile-flag-alone`

If `--profile` is given with `--url` or `--key`, then the CLI MUST exit 2 with `usage` and send no request.

**Tests:** `cli/profiles.test.ts › refuses --profile beside --url or --key`.

### `cli/profile-env-below-flags`

When `--url` or `--key` is given, the CLI MUST NOT read `MARFA_PROFILE`.

**Tests:** `cli/profiles.test.ts › reads no MARFA_PROFILE beside --url or --key`.

### `cli/profile-env-alone`

If `MARFA_PROFILE` is set beside a `MARFA_API_URL` or `MARFA_API_KEY` that is not empty, and none of `--profile`, `--url` and `--key` is given, then the CLI MUST exit 2 with `usage` and send no request.

**Reason:** any reading of the two together either sends one server's key to the other or picks a server the person did not mean.

**Tests:** `cli/profiles.test.ts › refuses MARFA_PROFILE beside MARFA_API_URL or MARFA_API_KEY, sending nothing`.

### `cli/profile-key-own-server`

The CLI MUST NOT send a profile's key to any server but the one the profile names.

**Tests:** `cli/profiles.test.ts › takes the server and key from --profile, reading none of the variables`, `› refuses MARFA_PROFILE beside MARFA_API_URL or MARFA_API_KEY, sending nothing`.

### `cli/profile-no-other-key`

While a profile names the server, the CLI MUST NOT send that server any key but the profile's.

**Tests:** `cli/profiles.test.ts › sends a profile's server no key but the profile's`.

### `cli/profile-key-command-key`

When a profile's key command exits 0 having printed one line, the CLI MUST send that line, without the white space around it, as the profile's key.

**Tests:** `cli/profiles.test.ts › takes the server and key from --profile, reading none of the variables`.

### `cli/profile-key-command-argv`

When the CLI runs a profile's key command, the CLI MUST run the program and arguments the profile lists, without a shell.

**Reason:** a shell would read quotes, variables and separators in the arguments, so a value meant literally would run as a command.

**Tests:** `cli/profiles.test.ts › runs the key command once in a run, as an argument list without a shell, with no standard input`.

### `cli/profile-key-command-stdin`

When the CLI runs a profile's key command, the CLI MUST give it no standard input.

**Reason:** the CLI's standard input can carry a body or a key meant for the command the person ran.

**Tests:** `cli/profiles.test.ts › runs the key command once in a run, as an argument list without a shell, with no standard input`.

### `cli/profile-key-command-once`

The CLI MUST run a profile's key command at most once in a run.

**Reason:** a key command can ask the person to approve it, and a run sends many requests.

**Tests:** `cli/profiles.test.ts › runs the key command once in a run, as an argument list without a shell, with no standard input`.

### `cli/profile-key-command-failed`

If a profile's key command cannot be started, exits other than 0, is ended by a signal, stops or starts a program that stops, as reading from or writing to the terminal makes it, prints nothing, prints more than one line, prints more than 16 KiB or prints text that is not UTF-8, then the CLI MUST exit 5 with `key_command` and send no request that carries a key.

**Reason:** the key command runs in a process group of its own, so a terminal that it, or a program it starts, reads or writes stops that process with `SIGTTIN` or `SIGTTOU`, and no one is there to continue it. A shell running a pipeline waits on a stopped program for ever.

**Tests:** `cli/profiles.test.ts › refuses a key command that fails with key_command and exit 5, sending nothing and showing none of its output`.

### `cli/profile-key-command-names`

If the CLI refuses a profile's key command, then the CLI MUST name the profile and the program in the message.

**Tests:** `cli/profiles.test.ts › refuses a key command that fails with key_command and exit 5, sending nothing and showing none of its output`.

### `cli/profile-key-command-quiet`

If the CLI refuses a profile's key command, then the CLI MUST NOT print anything the command printed on its standard output.

**Reason:** what a failing key command printed may be the key, or part of it.

**Tests:** `cli/profiles.test.ts › refuses a key command that fails with key_command and exit 5, sending nothing and showing none of its output`.

### `cli/profile-file-writable`

If the profile file, or the folder that holds it, can be written by anyone but its owner, through its group or other mode bits or, on macOS, through an allow entry of its access control list, then the CLI MUST exit 2 with `usage` and print nothing the file holds.

**Reason:** whoever can change the file can name a key command, which the CLI runs as the person.

**Tests:** `cli/profiles.test.ts › refuses a profile file or folder others can write, or a field it does not know, never showing what the file holds`.

### `cli/profile-unknown-field`

If a profile in the file holds a field the CLI does not know, then the CLI MUST exit 2 with `usage` and print no value from the file.

**Reason:** a misspelled `key_command` would otherwise leave the profile taking its key from the keychain unseen.

**Tests:** `cli/profiles.test.ts › refuses a profile file or folder others can write, or a field it does not know, never showing what the file holds`.

### `cli/command-write-line`

When a command is about to send a server, with a key or without one, or the private socket that `--socket` names, the first request in its run that can change data, the CLI MUST first print `marfa: writing to <origin>` on standard error as one plain line, with `unix:<path>` as the origin of the socket, followed by ` (profile <name>)` where a profile named that server.

**Reason:** a person or an agent with a test server and a real one sees which one a write goes to before it is made.

**Tests:** `cli/profiles.test.ts › names the server and profile on stderr before the first write, under --json too, and nothing for a read`.

### `cli/command-read-no-line`

When a command sends a server only requests that change no data, including a read sent as `POST` and each step of signing in (registering the client, asking for a device code, asking for a token, refreshing it and revoking it), the CLI MUST NOT print `marfa: writing to`.

**Reason:** signing in changes no data the server holds, so the line would warn of a write that is not made.

**Tests:** `cli/profiles.test.ts › names the server and profile on stderr before the first write, under --json too, and nothing for a read`, `cli/login.test.ts › signs in with a device code approved in a browser session, and the token reaches the data plane`.

### `cli/command-json-refusal-last`

While `--json` is given, if a command is refused, then the CLI MUST print the refusal as one JSON object on the last line of standard error, after any plain line such as a warning or the line of `cli/command-write-line`.

**Tests:** `cli/profiles.test.ts › names the server and profile on stderr before the first write, under --json too, and nothing for a read`.

### `cli/command-json-refusal-members`

While `--json` is given, if a command is refused, then the CLI MUST give the refusal object an `exit` member and an `error` member holding `code`, `message`, `server`, `local` and `retry_after_seconds`.

**Tests:** `cli/exits.test.ts › leaves by 1 when the server refuses, carrying the server's answer`, `› names no server in a refusal the working copy made itself, and the code it gave it`.

### `cli/command-json-server-answered`

If a server answered the request a command is refused for, then the CLI MUST give the refusal's `server` member the answer's `status`, `code` and `details` as the server sent them, whatever code the CLI names the refusal by.

**Reason:** a script reads `server` to learn what the server said, such as the `401` behind a `copy_expired` or an `unauthorized` that ended a watch, and the member holds only what a server sent.

**Tests:** `cli/exits.test.ts › leaves by 1 when the server refuses, carrying the server's answer`, `› reports a server's refusal to a device command in server, with no local code`, `› carries the server's own 401 beside the copy_expired a refused key ends a hydration with`, `device/refusal-answers.test.ts › names the answer behind a copy a hydration expired, with the details the server sent`.

### `cli/command-json-server-null`

If a command is refused without a server having answered the request, then the CLI MUST set the refusal's `server` member to `null`.

**Reason:** a refusal the working copy makes itself says nothing of the server, and a script that read a status from it would conclude the server was asked.

**Tests:** `cli/exits.test.ts › names no server in a refusal the working copy made itself, and the code it gave it`.

### `cli/command-json-local-code`

If the working copy names a refusal by a code that no server sent for it, then the CLI MUST give the refusal's `local` member that `code` and its `details`.

**Reason:** the code says why the copy refused, such as `not_held` for an item outside it, or `credential_refused` for a watch that stopped after the server refused its key, and has no place in `server`, which holds only a server's words.

**Tests:** `cli/exits.test.ts › names no server in a refusal the working copy made itself, and the code it gave it`.

### `cli/command-json-local-null`

If a refusal carries no code of the working copy's own beyond the code a server sent, then the CLI MUST set the refusal's `local` member to `null`.

**Tests:** `cli/exits.test.ts › reports a server's refusal to a device command in server, with no local code`.

### `cli/profile-socket-refused`

If `--profile`, or a `MARFA_PROFILE` that is not empty, is given with `--socket`, then the CLI MUST exit 2 with `usage`.

**Tests:** `cli/profiles.test.ts › refuses --profile and MARFA_PROFILE beside --socket, and --profile on server commands`.

### `cli/profile-server-command-refused`

If a `marfa server` command is given `--profile`, then the CLI MUST exit 2 with `usage`.

**Reason:** the command runs Docker on this machine and contacts no Marfa server, so a person who gave a profile would believe it was used.

**Tests:** `cli/profiles.test.ts › refuses --profile and MARFA_PROFILE beside --socket, and --profile on server commands`.

### `cli/profile-keychain-commands`

Where a profile has a key command, if `login` without `--print-token`, `logout`, `keys keep` or `keys forget` is given that profile, then the CLI MUST exit 2 with `usage`.

**Reason:** the profile never reads the keychain, so the command would change nothing the profile uses.

**Tests:** `cli/profiles.test.ts › refuses keychain commands for a profile whose key comes from a key command`.

### `cli/whoami-profile`

When `whoami` runs with a profile, the CLI MUST report the profile's name as `profile`.

**Tests:** `cli/profiles.test.ts › takes the server and key from --profile, reading none of the variables`.

### `cli/whoami-key-command`

When `whoami` runs with a profile that has a key command, the CLI MUST report `key_command` as the credential's `from`.

**Tests:** `cli/profiles.test.ts › takes the server and key from --profile, reading none of the variables`.

## The server the CLI talks to

The CLI is built for one contract version, the version of the document it was generated from, and every answer names the contract it speaks in `X-Marfa-Contract` (`instance/contract-header`).

### `cli/command-contract-mismatch`

If an answer to a command other than `status` and `whoami` names a contract other than the one the CLI was built for, then the CLI MUST refuse it `contract_mismatch` with exit 1.

**Reason:** a body shaped for another contract may be shaped and sized in ways the CLI cannot read. `status` and `whoami` exist to say which contract a server speaks, so they report it and exit 0 (`cli/status-other-contract`, `cli/whoami-other-contract`).

**Tests:** `device/contract.test.ts › refuses an answer on another contract rather than reading it`, `› refuses contract_mismatch from every command but status and whoami`, `› refuses an event stream on another contract, and reads one on its own`, `› reads every door on its own contract, so the refusal above is the contract's`, `› names an invocation for every command in the table, and nothing else`, `› drives every command the binary has, or says why not`, `device/contract.test.ts › refuses a content response on another contract from a bound folder push`, `› holds item summaries to the contract through its private socket`, `› holds both app narrowing responses to the contract through its private socket`, `› holds every owner passkey command to the contract through its private socket`, `› holds every backup command to the contract through its private socket`, `› holds owner update to the contract through its private socket`, `› holds profile update to the contract through its ordinary credential`, `› holds the profile avatar upload to the contract through its ordinary credential`, `› holds the owner avatar upload to the contract through its private socket`, `› holds every bin command to the contract through its private socket`, `› holds folder inventory to the contract through its private socket`, `› holds attention to the contract through its private socket`.

### `cli/command-mismatch-prints-nothing`

When the CLI refuses an answer for its contract, the CLI MUST print nothing of the answer.

**Tests:** `device/contract.test.ts › refuses an answer on another contract rather than reading it`, `› refuses contract_mismatch from every command but status and whoami`, `› holds item summaries to the contract through its private socket`, `› holds every owner passkey command to the contract through its private socket`, `› holds every backup command to the contract through its private socket`, `› holds owner update to the contract through its private socket`, `› holds profile update to the contract through its ordinary credential`, `› holds the profile avatar upload to the contract through its ordinary credential`, `› holds the owner avatar upload to the contract through its private socket`, `› holds every bin command to the contract through its private socket`, `› holds folder inventory to the contract through its private socket`, `› holds attention to the contract through its private socket`.

### `cli/command-unnamed-success`

If a success names no contract, then the CLI MUST refuse it `contract_mismatch` with exit 1.

**Tests:** `device/contract.test.ts › refuses a success that names no contract`, `› holds item summaries to the contract through its private socket`, `› holds every owner passkey command to the contract through its private socket`, `› holds every backup command to the contract through its private socket`, `› holds owner update to the contract through its private socket`, `› holds profile update to the contract through its ordinary credential`, `› holds the profile avatar upload to the contract through its ordinary credential`, `› holds the owner avatar upload to the contract through its private socket`, `› holds every bin command to the contract through its private socket`, `› holds folder inventory to the contract through its private socket`, `› holds attention to the contract through its private socket`.

### `cli/command-contract-twice`

If an answer names its contract on two header lines that differ, then the CLI MUST refuse it `contract_mismatch`.

**Tests:** `device/contract.test.ts › refuses an answer that names its contract twice, differently`.

### `cli/command-contract-repeated`

When an answer names the CLI's own contract on two header lines, the CLI MUST read it as an answer on that contract.

**Tests:** `device/contract.test.ts › refuses an answer that names its contract twice, differently`.

### `cli/command-write-sent`

If the answer to a write the CLI sent names another contract and is not the server's own `412 contract_mismatch`, then the CLI MUST say in its refusal that the write was sent and may have taken effect.

**Reason:** the contract is named by the answer, so the server acted on the write before the CLI could read that it speaks another contract.

**Tests:** `device/contract.test.ts › says a write it refused for its contract was sent and may have taken effect`, `› holds both app narrowing responses to the contract through its private socket`.

### `cli/command-write-declined`

If the answer to a write the CLI sent is the server's own `412 contract_mismatch`, then the CLI MUST say in its refusal that the server refused the write before it acted.

**Reason:** the server judges the contract before it acts on a request, so a write it refused for its contract changed nothing.

**Tests:** `device/contract.test.ts › says a write the server refused 412 contract_mismatch was refused before it acted, not that it may have taken effect`.

### `cli/command-write-declined-not-sent`

If the answer to a write the CLI sent is the server's own `412 contract_mismatch`, then the CLI MUST NOT say in its refusal that the write may have taken effect.

**Tests:** `device/contract.test.ts › says a write the server refused 412 contract_mismatch was refused before it acted, not that it may have taken effect`.

### `cli/command-unnamed-refusal`

If a refusal names no contract, then the CLI MUST report it `unnamed_answer` with exit 3, naming its status.

**Reason:** the server names its contract on every answer, so a refusal naming none is from something in front of it, such as a proxy.

**Tests:** `device/contract.test.ts › hands on a refusal that names no contract, as a proxy's would`.

### `cli/command-unreachable-origin`

If the CLI cannot reach the server it was sent to, then the CLI MUST report it `network` with exit 3, in a message that names the server by its scheme, host and port alone.

**Reason:** a person with several servers needs to know which one did not answer, and a gateway's path or a credential in the address must not reach a terminal or a log.

**Tests:** `cli/exits.test.ts › leaves by 3 when the server cannot be reached`.

### `cli/command-unreachable-code-once`

If the CLI reports `network`, then the CLI MUST NOT begin the message with the word `network`.

**Reason:** a surface that prints the code beside the message would show it twice.

**Tests:** `cli/exits.test.ts › leaves by 3 when the server cannot be reached`.

### `cli/command-unreachable-hint`

If a connection to a server on this machine is refused, then the CLI MUST ask a person whether the server is running and name `marfa server status`.

**Reason:** a refused connection means nothing listens at the address, and a person who sees only that nothing answered cannot tell a stopped server from a wrong address. Another failure, such as a timeout, does not say that the server is stopped.

**Tests:** `cli/exits.test.ts › asks a person whether the server is running when nothing listens on this machine, and says so only to a person`.

### `cli/command-unreachable-hint-not-in-json`

If a connection to a server is refused and `--json` is set, then the CLI MUST NOT add advice to the envelope's message.

**Reason:** a script reads the envelope's code and message, and advice for a person would change what it matches.

**Tests:** `cli/exits.test.ts › asks a person whether the server is running when nothing listens on this machine, and says so only to a person`.

### `cli/command-local-only-refusal`

If the server refuses a command with `details.needs` set to `local`, then the CLI MUST tell a person that the private local command can do it.

**Reason:** the server says which refusals only the private local command can mend, so the CLI decides by that detail and not by the words of the message.

**Tests:** `cli/owner-commands.test.ts › holds a sign-in address change until its flag confirms it, and tells a key the private command is the way`.

### `cli/command-local-only-refusal-details`

If the server refuses a command with `details`, then the CLI MUST carry `details` unchanged in the `--json` envelope's `server` member.

**Reason:** a script decides what to do from the server's own detail, not from the CLI's advice.

**Tests:** `cli/owner-commands.test.ts › holds a sign-in address change until its flag confirms it, and tells a key the private command is the way`.

### `cli/command-address-change-flag`

If a person runs `config update` or `config replace` with `--confirm-address-change`, then the CLI MUST send `confirm_sign_in_address_change` set to `true` with the body.

**Reason:** the server holds a sign-in address change until it is confirmed, and a person confirms it by naming the flag after reading what the change does.

**Tests:** `cli/owner-commands.test.ts › holds a sign-in address change until its flag confirms it, and tells a key the private command is the way`.

### `cli/command-upload-refusal-reported`

If the server refuses an upload before it reads the file, then the CLI MUST report the refusal's status, code and message.

**Reason:** a server that refuses early closes the connection while the CLI is still sending, and a CLI that holds the file back until the server's go-ahead, for up to two seconds, reads the answer the server gave, which is the only thing that tells a person why the upload failed.

**Tests:** `cli/attach.test.ts › reports the server's refusal of an upload it made before reading the file, not a broken connection`, `cli/archive-blobs.test.ts › reports the refusal of a large archive the server refuses before or while it arrives`.

### `cli/command-upload-refusal-not-network`

If the server refuses an upload before it reads the file, then the CLI MUST NOT report a network failure.

**Reason:** the server answered, and a network failure would send a person to the connection instead of the refusal.

**Tests:** `cli/attach.test.ts › reports the server's refusal of an upload it made before reading the file, not a broken connection`.

### `cli/command-server-status-says-health`

If the server of an install answers `/health` as degraded or down, then the CLI MUST say so in `marfa server status`, with the components at fault.

**Reason:** a server that answers has not gone silent, and "not answering" is for a server that gave no answer.

**Tests:** `cli/server-status.test.ts › says a server that answers degraded is degraded, and leaves by 0`, `› says a server that answers down is down, not silent, and leaves by 0`.

### `cli/command-server-status-exits-zero`

If the server of an install answers `/health` as degraded or down, then the CLI MUST leave `marfa server status` by 0.

**Reason:** a script reads `running`, `answering` and `health` in the `--json` report, and a non-zero exit would fail the scripts that pipe `status` to learn how the server is.

**Tests:** `cli/server-status.test.ts › says a server that answers degraded is degraded, and leaves by 0`, `› says a server that answers down is down, not silent, and leaves by 0`.

### `cli/command-server-status-says-no-backups`

If the server of an install answers `/health` with `backups.status` `off` and `backups.reason` `no_backup_destination`, then the CLI MUST say in `marfa server status` that no backups are kept.

**Reason:** an install made with no destination keeps no backup, and the person who made it has no other sign.

**Tests:** `cli/server-status.test.ts › says no backups are kept, and how to set one, when the server has no destination`.

### `cli/command-server-status-backup-setting`

If the server of an install answers `/health` with `backups.reason` `no_backup_destination`, then the CLI MUST name in `marfa server status` `MARFA_BACKUP_PATH`, `S3_BUCKET`, the install's settings file and `marfa server restart`.

**Reason:** a person needs to know which setting to add, where, and how to make the server read it.

**Tests:** `cli/server-status.test.ts › says no backups are kept, and how to set one, when the server has no destination`.

### `cli/command-server-status-says-backups-off`

If the server of an install answers `/health` with `backups.reason` `turned_off`, then the CLI MUST say in `marfa server status` that scheduled backups are turned off.

**Tests:** `cli/server-status.test.ts › says scheduled backups are turned off, apart from having no destination`.

### `cli/command-server-status-off-not-none`

If the server of an install answers `/health` with `backups.reason` `turned_off`, then the CLI MUST NOT say in `marfa server status` that no backups are kept.

**Reason:** an interval of 0 is a choice about the schedule, and a destination is set.

**Tests:** `cli/server-status.test.ts › says scheduled backups are turned off, apart from having no destination`.

### `cli/command-server-status-quiet-backups`

If the server of an install answers `/health` with `backups.status` `ok`, then the CLI MUST NOT mention backups in the text of `marfa server status`.

**Tests:** `cli/server-status.test.ts › says nothing of backups that run`.

### `cli/command-server-status-json-backups`

When the server of an install answers `/health` with a `backups` object, the CLI MUST give `marfa server status --json` a `backups` member with its `status`, its `reason` and the `say` the text shows, or `null` when the text says nothing.

**Reason:** a script reads the report, and the words are the same for it as for a person.

**Tests:** `cli/server-status.test.ts › says no backups are kept, and how to set one, when the server has no destination`, `› says nothing of backups that run`.

### `cli/command-redirect`

If an answer to the CLI is a `3xx`, then the CLI MUST refuse it `redirect` with exit 1, naming the status and the destination, without following it.

**Tests:** `device/contract.test.ts › refuses a redirect without following it`.

### `cli/command-no-root-first`

When the CLI sends a call other than a mint, `status` or `whoami`, the CLI MUST send that call alone, with no read of the server's root before it.

**Tests:** `device/contract.test.ts › reads an answer on its own contract, sending only the call`, `› holds item summaries to the contract through its private socket`, `› holds every owner passkey command to the contract through its private socket`, `› holds every backup command to the contract through its private socket`, `› holds owner update to the contract through its private socket`, `› holds profile update to the contract through its ordinary credential`, `› holds the profile avatar upload to the contract through its ordinary credential`, `› holds the owner avatar upload to the contract through its private socket`, `› holds every bin command to the contract through its private socket`, `› holds folder inventory to the contract through its private socket`, `› holds attention to the contract through its private socket`.

### `cli/command-mint-root-first`

When the CLI sends a write whose answer is the only copy of what it mints, `keys create` or `webhooks create`, the CLI MUST first read the server's root.

**Reason:** a mint refused for its contract has already minted a key or a secret nobody can read.

**Tests:** `device/contract.test.ts › sends no mint to a server whose root names another contract, or none`.

### `cli/command-mint-not-sent`

If the server's root names another contract, or none, then the CLI MUST NOT send a mint.

**Tests:** `device/contract.test.ts › sends no mint to a server whose root names another contract, or none`.

### `cli/command-root-header`

The CLI MUST take the contract the server speaks from the `X-Marfa-Contract` header of the root's answer, whatever the root's body says.

**Tests:** `device/contract.test.ts › takes the served contract from the answer's header, whatever the root's body says`, `› sends no mint to a server whose root names another contract, or none`.

### `cli/status-other-contract`

When `status` reads a server on another contract, the CLI MUST report the contract the server speaks beside the one it was built for, and exit 0.

**Tests:** `device/contract.test.ts › still says which server this is, and that its contract is another`, `› says in words that the server speaks another contract`, `› takes the served contract from the answer's header, whatever the root's body says`.

### `cli/status-other-contract-no-counts`

When `status` reads a server on another contract, the CLI MUST NOT ask it for the item counts.

**Tests:** `device/contract.test.ts › still says which server this is, and that its contract is another`.

### `cli/whoami-other-contract`

When `whoami` reads a server on another contract, the CLI MUST report the contract the server speaks beside the one it was built for, and exit 0.

**Tests:** `device/contract.test.ts › takes the served contract from the answer's header, whatever the root's body says`.

### `cli/whoami-person`

When `whoami` runs with an access token on a server on its own contract, the CLI MUST report the server's answer to `GET /profile` as the credential's `person`.

**Tests:** `cli/login.test.ts › signs in with a device code approved in a browser session, and the token reaches the data plane`.

### `cli/whoami-ended-token`

If the server answers `whoami`'s `GET /profile` with `401`, then the CLI MUST exit 5 and print nothing on standard output.

**Reason:** A token that has ended names no one, and a script that checks who it is signed in as must not read a success.

**Tests:** `cli/login.test.ts › signs in with a device code approved in a browser session, and the token reaches the data plane`.

### `cli/whoami-key`

When `whoami` runs with a credential that is not an access token on a server on its own contract, the CLI MUST report the server's answer to `GET /keys/current` as the credential's `key`.

**Tests:** `cli/exits.test.ts › leaves whoami by 5 when the server refuses the key, and names a key it accepts`, `device/contract.test.ts › takes the served contract from the answer's header, whatever the root's body says`.

### `cli/whoami-ended-key`

If the server answers `whoami`'s `GET /keys/current` with `401`, then the CLI MUST exit 5 and print nothing on standard output.

**Reason:** A key that was revoked, or never minted, reaches nothing, and a script that checks its credential must not read a success.

**Tests:** `cli/exits.test.ts › leaves whoami by 5 when the server refuses the key, and names a key it accepts`.

### `cli/status-counts-not-permitted`

If the server refuses `status` the item counts `403 type_not_permitted`, then the CLI MUST still describe the server, say the counts need a working key and exit 0.

**Reason:** a credential whose type permissions reach no type is refused the counts (`keys-and-oauth/permissions-no-content`).

**Tests:** `device/contract.test.ts › describes the server to a key that reaches no type, and says the counts need a working key`.

### `cli/status-counts-refused`

If the server refuses `status` the item counts for any other reason, then the CLI MUST fail with that refusal.

**Tests:** `device/contract.test.ts › hands on any other refusal of the counts`.

### `cli/operations-offline`

The CLI MUST print its table of operations without sending a request.

**Tests:** `device/contract.test.ts › sends nothing to print the table`.

### `cli/claim-stdin`

When `setup claim --stdin` runs, the CLI MUST read the email, password and setup code from a JSON object on standard input.

**Reason:** passwords and setup codes must not be left in shell history or process arguments.

**Tests:** `device/contract.test.ts › claims the owner with setup proof and password read from structured stdin`.

### `cli/claim-invalid-stdin`

If `setup claim --stdin` reads blank or malformed JSON, then the CLI MUST refuse it `invalid`.

**Tests:** `device/contract.test.ts › claims the owner with setup proof and password read from structured stdin`.

### `cli/claim-invalid-not-sent`

If `setup claim --stdin` reads blank or malformed JSON, then the CLI MUST NOT send a claim.

**Tests:** `device/contract.test.ts › claims the owner with setup proof and password read from structured stdin`.

### `cli/claim-refused-proof-exit`

If the server answers `setup claim` `401 setup_proof_invalid`, then the CLI MUST exit `1`, with the server's code in the error's `server.code`.

**Reason:** a wrong, spent or replaced setup code is a refusal that asking for a new code fixes, so the exit `5` for a missing or ended credential (`sign in again`) would send a person or an agent to the wrong remedy.

**Tests:** `device/contract.test.ts › exits 1, not 5, when the server refuses the setup code`.

### `cli/local-socket-exclusive`

When `--socket PATH` is supplied, the CLI MUST reject ordinary URL or credential selection.

**Tests:** `device/contract.test.ts › refuses ambiguous or unavailable sockets without falling back to HTTP`.

### `cli/local-socket-no-fallback`

If the selected private socket cannot be reached safely, then the CLI MUST fail without falling back to HTTP or stored credentials.

**Tests:** `device/contract.test.ts › refuses ambiguous or unavailable sockets without falling back to HTTP`.

### `cli/local-socket-streamed`

When a command given `--socket PATH` streams its answer, the CLI MUST send that request through the socket and to no other address.

**Reason:** a streamed answer is read on its own connection, which has to reach the private socket as every other request does.

**Tests:** `cli/instance.test.ts › downloads a blob through the private socket, byte for byte`, `device/contract.test.ts › explains a 401 through --socket as an operation that needs a key, with the credential exit`.

### `cli/local-socket-needs-key`

If the server answers `401` to a request that a command sent through `--socket PATH`, then the CLI MUST fail with exit `5`, saying the operation needs a key, which `--socket` does not carry.

**Reason:** direct local authority carries no key, so the `401` is not an expired or wrong key, and the usual advice to sign in again would mislead.

**Tests:** `device/contract.test.ts › explains a 401 through --socket as an operation that needs a key, with the credential exit`, `cli/instance.test.ts › explains a 401 through the private socket as an operation that needs a key, for streamed and plain commands`.

### `cli/local-socket-names-key-needs`

If the server answers `401` to a request that a command sent through `--socket PATH`, then the CLI MUST say that item properties, edges, tags, search, counts, events and exports need a key, and that `items summaries`, `items bin`, `items trash`, `items restore` and `items purge` of one item, the `blobs` commands, and `items bulk-action job` and `items bulk-action cancel` work through `--socket` without one.

**Reason:** a person who ran a command that needs a key through the socket needs to know which commands the socket reaches before choosing a key, as `items/local-authority-content` and `search-and-filters/owner-read-boundary` set.

**Tests:** `device/contract.test.ts › explains a 401 through --socket as an operation that needs a key, with the credential exit`, `cli/instance.test.ts › explains a 401 through the private socket as an operation that needs a key, for streamed and plain commands`.

### `cli/redeliver-request`

When `webhooks redeliver <id> <delivery_id>` runs, the CLI MUST send one `POST /webhooks/{id}/deliveries/{delivery_id}/redeliver` using its selected credential or private socket and no body, each identifier encoded as a path segment of its own.

**Reason:** the server decides from its current authority and retained deliveries whether to send again (`events/redeliver-current`).

**Tests:** `device/contract.test.ts › posts redelivery with encoded ids and no body`, `› sends webhook reads and retries through the private socket`.

### `cli/credential-lock-unsafe`

If the file the CLI keeps as a server's credential lock can be read or written by another user, then the CLI MUST refuse `invalid`, naming the credential lock, before it sends anything.

**Tests:** `device/credential-locks.test.ts › refuses an unsafe credential lock across environment overrides before contacting the server`, `› refuses to keep a key under an unsafe credential lock, keeping nothing and sending nothing`, `› refuses a sign-in under an unsafe credential lock before asking for a code`.

### `cli/credential-lock-taken`

While another process changes the credential kept for a server, as a refresh, `logout` or `keys forget` does, the CLI MUST keep no credential for that server through `login` or `keys keep` until that change ends.

**Reason:** a credential written beside a refresh in another process would be overwritten by the refreshed one, or brought back after a logout.

**Tests:** `device/credential-locks.test.ts › keeps a key only once another process has finished changing the kept credential`, `› keeps a sign-in's token only once another process has finished changing the kept credential`.

### `cli/credential-refresh-then-logout`

If `logout` runs while another process refreshes the kept sign-in for the same server, then the CLI MUST revoke the refresh token that the refresh keeps.

**Reason:** a revocation of the token the refresh replaced would leave the rotated one standing.

**Tests:** `device/credential-locks.test.ts › revokes the token a refresh under way keeps, when a sign-out waits on it`.

### `cli/credential-logout-then-refresh`

If a refresh of a kept sign-in starts while `logout` for the same server runs in another process, then the CLI MUST NOT refresh or keep again the sign-in that `logout` forgets.

**Reason:** a refresh that read the credential before the logout ended would bring back a sign-in the person ended.

**Tests:** `device/credential-locks.test.ts › brings back no sign-in a sign-out under way forgets, when a refresh waits on it`.

### `cli/command-logout-forgets`

When `logout` signs out of a kept sign-in, the CLI MUST forget the kept token, whether or not the server takes its revocation.

**Tests:** `device/credential-locks.test.ts › reports a sign-out the server did not revoke as revoked: false, and forgets the token either way`.

### `cli/command-logout-not-revoked`

If `logout` signs out of a sign-in that kept no revocation endpoint, or whose revocation the server refuses or cannot be reached for, then the CLI MUST report `revoked: false`.

**Reason:** a sign-out that claimed a revocation it never had would leave a person believing a token is dead while it stands until it expires.

**Tests:** `device/credential-locks.test.ts › reports a sign-out the server did not revoke as revoked: false, and forgets the token either way`.

### `cli/command-logout-off`

While the keychain is off, when `logout` is given a sign-in token with `--key` or `MARFA_API_KEY` and the client id it was issued to with `--client-id`, the CLI MUST ask the revocation endpoint that the discovery document of the server `--url` or `MARFA_API_URL` names gives, and no other server, to revoke the token for that client, with the token's type.

**Reason:** a token printed by `login --print-token` is kept nowhere, so a sign-out that only forgot it would end nothing. The revocation door needs the client the token was issued to.

**Tests:** `device/credential-locks.test.ts › revokes the token it is handed when the keychain is off, and says so only when the server then refuses it`.

### `cli/command-logout-off-profile`

While the keychain is off, if a profile is chosen for `logout`, then the CLI MUST exit 2 with `usage` and send no request.

**Reason:** a profile's credential is its own, so a token handed to `logout` cannot be for it.

**Tests:** `cli/profiles.test.ts › refuses logout with a profile chosen while the keychain is off, sending nothing`.

### `cli/command-logout-off-still-works`

While the keychain is off, if the server still accepts an access token after `logout` asked for its revocation, then the CLI MUST exit 1.

**Reason:** the revocation door answers the same for a token it did not end, as when the client id is another client's, so its answer proves nothing.

**Tests:** `device/credential-locks.test.ts › revokes the token it is handed when the keychain is off, and says so only when the server then refuses it`.

### `cli/command-logout-off-confirmed`

While the keychain is off, when the server refuses an access token after `logout` asked for its revocation, the CLI MUST report `accepted: false`.

**Reason:** a refusal is the only proof the token no longer works, and it does not show this revocation ended it, as a token that had expired is refused alike; a refresh token has no such check.

**Tests:** `device/credential-locks.test.ts › revokes the token it is handed when the keychain is off, and says so only when the server then refuses it`.

### `cli/command-keys-forget-offline`

When `keys forget` runs, the CLI MUST forget the credential kept for the server without sending a request.

**Reason:** a credential is often forgotten for a server that is gone.

**Tests:** `device/credential-locks.test.ts › forgets a kept key without sending anything`.

### `cli/command-keys-keep-checks-current-key`

When `keys keep` is given a key, the CLI MUST check the key with `GET /keys/current` and no other request before it keeps the key.

**Reason:** every key may read itself, whatever permissions and types it holds (`keys-and-oauth/current-key`). A check through an item route would refuse a key that holds only permissions, which works from `MARFA_API_KEY` all the same (`keys-and-oauth/permissions-no-content`).

**Tests:** `device/credential-locks.test.ts › keeps a key that reaches no type, checking it with the key's own read and nothing else`.

### `cli/command-keys-keep-keeps-key-without-type`

When the server answers `GET /keys/current` to a key that reaches no type, the CLI MUST keep the key for the server.

**Tests:** `device/credential-locks.test.ts › keeps a key that reaches no type, checking it with the key's own read and nothing else`.

### `cli/command-keys-keep-refuses-spent-key`

If the server answers the check of `keys keep` `401 unauthorized`, as it does for a key that is revoked, expired or unknown, then the CLI MUST keep nothing and exit 5.

**Tests:** `device/credential-locks.test.ts › keeps nothing of $name, refusing it with exit $exit`.

### `cli/command-keys-keep-refuses-access-token`

If the server answers the check of `keys keep` `403 forbidden`, as it does for an app's access token (`keys-and-oauth/current-key-app`), then the CLI MUST keep nothing and refuse it `invalid` with exit 1, saying the credential is not a key.

**Reason:** an access token ends within the hour, and `login` keeps a sign-in that renews it.

**Tests:** `device/credential-locks.test.ts › keeps nothing of $name, refusing it with exit $exit`.

### `cli/command-keys-keep-refuses-wrong-server`

If the answer to the check of `keys keep` names another contract than the CLI was built for or none, then the CLI MUST keep nothing and refuse it as it refuses any such answer (`cli/command-contract-mismatch`, `cli/command-unnamed-refusal`).

**Tests:** `device/credential-locks.test.ts › keeps no key for $name, refusing it with exit $exit`.

### `cli/command-keychain-unreadable`

If no server is named by `--url`, `MARFA_API_URL` or a key, and the keychain that holds the current server cannot be read, then the CLI MUST report it `no_keychain` with exit 4, keeping the keychain's own reason, except for a command that runs on held bytes alone.

**Reason:** `no_server` tells a person to name a server, which does not help when a server is kept but a locked, missing or unreadable keychain hides it. While the keychain is off, or holds no current server, nothing is kept and `no_server` with exit 2 is right. `folders pull`, `folders restore` and `device blobs get` need no server for the bytes they hold, and over SSH on a Mac, where there is no default keychain, refusing them would stop work that needs no credential, so they run on what the device holds.

**Tests:** `device/contract.test.ts › reports a keychain that cannot be read as itself, not as no server named`, `device/contract.test.ts › runs a command on held bytes alone when the keychain cannot be read`.

### `cli/command-events-refuses-cursor`

If the stream that `events` reads sends a `cursor_ahead` or `catchup_too_old` frame (`events/cursor-ahead`, `events/catchup-too-old`), then the CLI MUST end the command `invalid` with exit 1, saying the cursor is not one the server's log holds.

**Reason:** the server answers `200` and ends the stream with the frame, so the status of the answer says nothing of the refusal, and a script that reads only the exit status would take a refused cursor for a stream that ended well.

**Tests:** `device/contract.test.ts › refuses a cursor the stream ends with $name for, with exit 1 and the envelope on standard error`.

### `cli/command-events-prints-refusing-frame`

When the CLI ends `events` for a `cursor_ahead`, `catchup_too_old` or `stream_incomplete` frame, the CLI MUST print the frame it read on standard output before it ends.

**Tests:** `device/contract.test.ts › refuses a cursor the stream ends with $name for, with exit 1 and the envelope on standard error`, `device/contract.test.ts › ends the command on a stream_incomplete frame for $reason with exit $exit, printing the frame`.

### `cli/command-events-refuses-incomplete`

If the stream that `events` reads sends a `stream_incomplete` frame whose `reason` is not `credential_ended` (`events/incomplete-closes`), then the CLI MUST end the command `stream_incomplete` with exit 3.

**Reason:** the stream can no longer deliver what it opened with, and the answer's status says nothing of it. A script that reads only the exit status would take a stream that stopped early for one that ended well. Exit 3 tells it to follow again from the frame's `cursor`.

**Tests:** `device/contract.test.ts › ends the command on a stream_incomplete frame for $reason with exit $exit, printing the frame`.

### `cli/command-stream-credential-ended`

If the stream that a command reads sends a `stream_incomplete` frame whose `reason` is `credential_ended` (`events/credential-revoked`), then the CLI MUST end the command `unauthorized` with exit 5, whichever command reads the stream.

**Reason:** the key or token that held the stream has ended, so reading again with it will not work. Exit 5 says to get a new credential, where exit 3 would send a script to retry. One place decides it, so `events`, `hydrate` and `catch-up` agree.

**Tests:** `device/contract.test.ts › ends the command on a stream_incomplete frame for $reason with exit $exit, printing the frame`, `device/cli-outcomes.test.ts › ends $command on a stream_incomplete frame for credential_ended with exit 5`.

### `cli/command-events-frame-name-decides`

If a `cursor_ahead`, `catchup_too_old` or `stream_incomplete` frame that `events` reads carries no data, or data that is not JSON, then the CLI MUST end the command as it does for the frame with its data, with the details the data would have named reported as unknown.

**Reason:** the frame's name alone says the stream is over, so a frame the CLI cannot read must not read as a stream that ended well.

**Tests:** `device/contract.test.ts › ends the command on a $event frame whose data is $data as it does for the frame with its data`.

### `cli/command-cleartext-warning`

If the CLI is about to send a key or a token to an `http` address whose host is not `localhost`, an address in `127.0.0.0/8` or `::1`, and neither `--allow-http` nor `MARFA_ALLOW_HTTP` states that it is intended, then the CLI MUST print a warning that names the address on standard error before it sends the credential.

**Reason:** a credential sent over plain `http` can be read by anyone on the path, and the owner may not have noticed the scheme of the address that was named.

**Tests:** `cli/cleartext.test.ts › warns before it sends a key to a plain http address on another host, and then sends it`, `› warns before a working copy sends a key to a plain http address on another host`.

### `cli/command-cleartext-sends`

When the CLI has printed the plain `http` warning, the CLI MUST go on to send the request.

**Reason:** an owner's private network may already be encrypted below the address, so the warning informs and does not refuse.

**Tests:** `cli/cleartext.test.ts › warns before it sends a key to a plain http address on another host, and then sends it`.

### `cli/command-cleartext-sign-in`

If `login` is given an `http` address whose host is not `localhost`, an address in `127.0.0.0/8` or `::1`, and neither `--allow-http` nor `MARFA_ALLOW_HTTP` states that it is intended, then the CLI MUST print a warning that names the address on standard error before it sends a request to it.

**Reason:** a sign-in sends a device code and receives tokens, and the person types a password on the address's sign-in page.

**Tests:** `cli/cleartext.test.ts › warns before a sign-in sends anything to a plain http address on another host`.

### `cli/login-code-ended`

If the server answers the poll of the device code that `login` waits on with `invalid_grant` or `expired_token`, then the CLI MUST end the sign-in with `device_code_ended` and exit 3, saying in its message that the code is no longer valid and to run `marfa login` again.

**Reason:** the server removes an unentered device code when 1000 newer ones are held (`keys-and-oauth/device-code-unentered-bound`), and answers one that ran out `expired_token`. A new `login` can succeed where the same code cannot, so the refusal is not one a retry fails to change (exit 1).

**Tests:** `cli/login.test.ts › ends a login whose device code the server removed with exit 3, saying to run marfa login again`, `› ends a login whose device code ran out with exit 3, saying to run marfa login again`.

### `cli/command-cleartext-loopback`

Where the address of the server is `http` and its host is `localhost`, an address in `127.0.0.0/8` or `::1`, the CLI MUST NOT print the plain `http` warning.

**Reason:** a request to this machine does not cross a network.

**Tests:** `cli/cleartext.test.ts › prints no warning for a plain http address on this machine, which it reaches with the key`.

### `cli/command-cleartext-https`

Where the address of the server is `https`, the CLI MUST NOT print the plain `http` warning.

**Tests:** `cli/cleartext.test.ts › prints no warning for an https address, which it reaches`.

### `cli/command-loopback-no-proxy`

When a command sends a request to `localhost`, an address in `127.0.0.0/8` or `::1`, the CLI MUST send it directly, whatever proxy the environment names, and that holds for a request made by following a redirect as for the first one.

**Reason:** a proxy cannot reach this machine, and would be handed the request with its key, and one that cannot reach it makes the checks of `marfa server` report the wrong health. A redirect names a new destination, so the rule is applied to it again.

**Tests:** `cli/key-and-files.test.ts › never goes through a proxy the environment names, and one to another host does`, `› is sent through the proxy or not by where it goes, each time`, `cli/server-status.test.ts › asks the server on this machine directly, whatever proxy the environment names`.

### `cli/command-redirect-no-credentials`

If a command follows a redirect from the docs site or from a link to a blob that changes the scheme, the host or the port, then the CLI MUST send no `Authorization`, `Proxy-Authorization` or `Cookie` header and no header whose name starts with `X-Marfa-` on that request or on any later request of the command, whatever `MARFA_API_KEY` holds.

**Reason:** the headers that say who is asking belong to the origin the command began at. An address that redirect names is another party's, and a later redirect back to the first origin does not make it the first one again.

**Tests:** `cli/key-and-files.test.ts › is sent through the proxy or not by where it goes, each time`, `› leaves what names the caller behind when it goes to another host or port`.

### `cli/command-key-own-server`

If `--url` names a server other than the one `MARFA_API_URL` names, `MARFA_API_KEY` is set and `--key` is not given, then the CLI MUST exit 2 with `usage` and send no request.

**Reason:** the two variables are exported as a pair for one server, and the key must not go to another.

**Tests:** `cli/key-and-files.test.ts › goes only to the server MARFA_API_URL names, and a --url for another server refuses`, `› sends logout's token only to the server MARFA_API_URL names, and refuses a --url for another server`.

### `cli/command-output-owner-only`

When a command writes to a file named by `--output`, the CLI MUST make the file readable and writable by its owner alone, whatever the umask.

**Reason:** an export or a download holds what the key could read, and a file made under the usual umask is open to other accounts on the machine.

**Tests:** `cli/key-and-files.test.ts › is readable by its owner alone whatever the umask, for an export and a download`.

### `cli/command-output-whole`

If a transfer to a file named by `--output` ends before the whole answer arrives, or a blob's bytes do not hash to the digest asked for, then the CLI MUST end with any earlier file at that path unchanged and no partial file beside it.

**Reason:** a person keeps the earlier file until a whole one replaces it.

**Tests:** `cli/key-and-files.test.ts › replaces the file at --output only when the download arrives whole and matches its digest`.

### `cli/command-text-printable`

When a command prints text a server holds, without `--json`, the CLI MUST print each control character and bidirectional formatting character in it as an escape sequence, a newline, a tab and an escape that starts a colour included, and add its own line breaks, columns and colour only around that text, and print two names that differ in any character as two different names.

**Reason:** a title, a name or a message is text on the line it was printed on, and must not move the cursor, erase a line, retitle the window, reorder what follows it, start a row of its own or colour what follows it, and an object holding both of two names that differ only by such a character must not show one value for them.

**Tests:** `cli/key-and-files.test.ts › prints no control or bidirectional character from a title, and --json is unchanged`, `› print no control or bidirectional character from a view's title`, `› stays on its own line, in its own column and uncoloured, in a list, the overview and a device's views`, `› says a key's label on the line of that key, however the label is written`, `› shows each as its own entry, with no control character on the terminal`.

### `cli/command-cleartext-allow-flag`

Where `--allow-http` is given, the CLI MUST NOT print the plain `http` warning.

**Tests:** `cli/cleartext.test.ts › prints no warning where --allow-http states it is intended, and sends the key`.

### `cli/command-cleartext-allow-env`

Where `MARFA_ALLOW_HTTP` is set to `1`, `true`, `yes` or `on`, the CLI MUST NOT print the plain `http` warning.

**Tests:** `cli/cleartext.test.ts › prints no warning where MARFA_ALLOW_HTTP states it is intended, and warns where it does not`.

### `cli/command-get-any-state`

When `marfa items get` runs, the CLI MUST send `state=any`.

**Reason:** a person reading an item by its id is asking for that item, the bin included.

**Tests:** `cli/items.test.ts › takes a note through archive, the bin, restore, and the purge`.

### `cli/command-get-shows-state`

When `marfa items get` prints an item whose state is not `active` without `--json`, the CLI MUST print its state in brackets, such as `[trashed]`.

**Tests:** `cli/items.test.ts › takes a note through archive, the bin, restore, and the purge`.

### `cli/command-row-path`

If the server refuses the one operation that `marfa rows put` or `marfa rows patch` sends, then the CLI MUST name the refused field by its path within the row, such as `values.amount`, in the message and in each `details.errors` path.

**Reason:** the person wrote one row, not a batch, so `operations.0` names nothing they sent. `marfa rows write` sends a batch and keeps the server's paths.

**Tests:** `cli/tables.test.ts › names the column of a refused put or patch, where a batch names the operation too`.

### `cli/command-row-no-operation`

If the server refuses the one operation that `marfa rows put` or `marfa rows patch` sends, then the CLI MUST leave `details.operation` out of the refusal it prints.

**Tests:** `cli/tables.test.ts › names the column of a refused put or patch, where a batch names the operation too`.

### `cli/command-row-keyed`

When `marfa rows write`, `put`, `patch`, `delete` or `undo` is given `--idempotency-key`, the CLI MUST send the value as `Idempotency-Key` on the one request the command makes.

**Reason:** a person or a script that sends a `patch`, a `delete` or an undo again after an answer it lost needs the server to answer the first one (`tables/rows-keyed-once`), and the command makes no key of its own because it cannot know the write is a retry.

**Tests:** `cli/tables.test.ts › sends the key of a row write, so a repeat is answered from the record and writes once`.

### `cli/command-row-unkeyed`

When `marfa rows write`, `put`, `patch`, `delete` or `undo` is not given `--idempotency-key`, the CLI MUST NOT send an `Idempotency-Key`.

**Tests:** `cli/tables.test.ts › sends the key of a row write, so a repeat is answered from the record and writes once`.

## Where a store is made

### `cli/command-makes-store`

When `hydrate` or `status` names a path where no store has been made, the CLI MUST make a store there.

**Reason:** the state report is how a caller learns that a hydration is owed before the first one.

**Tests:** `device/working-copy.test.ts › makes a store only to hydrate or to report its state, and refuses a path with none to every other command`.

### `cli/command-no-store`

If a `device` command other than `hydrate` and `status` names a path where no store has been made, then the CLI MUST refuse it `no_store` and leave the path as it found it.

**Reason:** a read answered from a store made for a mistyped path is an empty copy that reads as a real one, and a write queued there is a queue nothing will drain.

**Tests:** `device/working-copy.test.ts › makes a store only to hydrate or to report its state, and refuses a path with none to every other command`.

## A store opened to read

### `cli/command-reader-no-store`

If a command opens a store to read at a path where no store has been made, then the CLI MUST refuse it `no_store` with exit 2.

**Tests:** `device/cli-outcomes.test.ts › reports an absent reading store: %j`, `device/working-copy.test.ts › opens a store to read without claiming the writer role, and is told when it saves`.

### `cli/command-reader-not-a-store`

If a command opens a store to read at a path that holds a file that is not a store, then the CLI MUST NOT refuse it `no_store`.

**Tests:** `device/cli-outcomes.test.ts › reports an absent reading store: %j`.

### `cli/command-writer-lock-unwritable`

If a command opens a store to write and its writer lock file cannot be written, then the CLI MUST exit 4.

**Tests:** `device/working-copy.test.ts › refuses to open for writing a store whose lock file cannot be written, and still reads it`.

## A store that cannot be read

### `cli/store-damaged-names`

When the CLI refuses a store `store_damaged`, the CLI MUST name the store's path.

**Reason:** damage met part way through a read does not know which file it is in. The CLI names the store it was given, and an app asks the binding to check the store, which names it.

**Tests:** `device/damaged-store.test.ts › refuses a damaged store store_damaged, naming it and the writes its queue holds, and leaves it as it was`.

### `cli/store-damaged-says`

When the CLI refuses a store `store_damaged`, the CLI MUST say how many writes its queue holds that the server has not taken, waiting, blocked, refused or dead, or that its queue cannot be read whole.

**Tests:** `device/damaged-store.test.ts › refuses a damaged store store_damaged, naming it and the writes its queue holds, and leaves it as it was`, `› says a damaged store's queue cannot be read whole where its rows do not read`.

## Reads from a copy

### `cli/edge-get-unheld`

If a read of one edge by id names an edge its copy does not hold, then the CLI MUST refuse it `not_found` with `not_held` as the envelope's `local` code.

**Tests:** `device/batch-reads.test.ts › answers one edge, many in the order named, and refuses one not held`.

### `cli/view-cli-selection`

When a caller narrows `device items list` or `device search` by a saved view, the CLI MUST accept `--view` and refuse `--folder` as an unknown option.

**Tests:** `device/views.test.ts › accepts --view and refuses the removed --folder option`.

## Writes that wait for other writes

### `cli/command-queued-holds`

When the CLI queues a write that depends on others and prints it as text, the CLI MUST print how many writes it depends on after `waiting on`.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`, `› says in words what the writes of an attached or added file wait on, counting writes queued before them`.

### `cli/command-queued-after`

When the CLI queues a write that follows another and prints it as text, the CLI MUST print the write it follows after `after`.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`.

### `cli/command-queue-waiting`

When the CLI prints the queue as text and exactly one of the writes a write depends on has no verdict, is `blocked`, or is a create refused onto an item its natural key names that no read has found yet, the CLI MUST name that write after `waiting on`.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`, `› holds a write made to a refused create's item until a read finds the item its natural key names`, `› says in words what the writes of an attached or added file wait on, counting writes queued before them`.

### `cli/command-queue-not-waiting`

When the CLI prints the queue as text and every write a write depends on is answered `accepted`, `merged`, `conflicted` or `refused`, is `dead`, or is no longer in the queue, and none is a create refused onto an item that no read has found yet, the CLI MUST NOT print `waiting on` for it.

**Reason:** a dependency with such a verdict, or one withdrawn or discarded, no longer holds the write, though `depends_on` still names it.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`, `› discards a refused create no read can land, refusing unsent the writes waiting on it`.

### `cli/command-queue-unlanded`

When the CLI prints the queue as text, the CLI MUST print on the line of each create refused onto an item its natural key names that no read has found yet `its natural key names <id>, which no read has found; discard it to refuse the writes waiting on it`, with that item's id for `<id>`.

**Reason:** nothing but a read that finds the item or a discard (`queue-and-verdicts/discard-unlanded-takes-out`) takes such a create, or the writes waiting on it, out of the queue.

**Tests:** `device/queue.test.ts › discards a refused create no read can land, refusing unsent the writes waiting on it`.

### `cli/command-queue-after`

When the CLI prints the queue as text, the CLI MUST name after `after` the write each write follows.

**Tests:** `device/queue.test.ts › says in words which writes hold a queued write`.

## The CLI's drain

What the CLI prints and exits with for a drain.

### `cli/command-drain-report`

When a drain ends with a report and the CLI prints JSON, the CLI MUST print the whole report on standard output and nothing on standard error but the warning of `cli/command-cleartext-warning` and the line of `cli/command-write-line`.

**Tests:** `device/cli-outcomes.test.ts › keeps the complete $label drain report with exit $exit`, `› preserves answered writes before an interrupted later write`.

### `cli/command-exit-stopped`

When a drain stops because a refused credential parked the queue, the CLI MUST exit 5.

**Tests:** `device/cli-outcomes.test.ts › keeps the complete $label drain report with exit $exit`.

### `cli/command-exit-undelivered`

When a drain that a refused credential did not stop reports `unavailable` or a write `undelivered`, the CLI MUST exit 3.

**Tests:** `device/cli-outcomes.test.ts › keeps the complete $label drain report with exit $exit`, `› preserves answered writes before an interrupted later write`, `› exits 3 for a pass the server could not finish that left nothing undelivered`, `› exits 3 for a write left undelivered by a pass the server finished`.

### `cli/command-exit-done`

When a drain reports neither `stopped`, nor `unavailable`, nor a write `undelivered`, the CLI MUST exit 0, whatever verdicts the drain reached.

**Tests:** `device/cli-outcomes.test.ts › reports completed refusals separately and keeps exit zero`.

### `cli/command-refused-count`

When a drain refuses writes and the CLI prints its report as text, the CLI MUST print how many it refused as `refused <n> write(s)`.

**Tests:** `device/cli-outcomes.test.ts › reports completed refusals separately and keeps exit zero`.

## A renewal a drain meets

### `cli/command-renewal-error`

When a failed renewal ends a drain, the CLI MUST print the failure as its error on standard error and nothing on standard output.

**Tests:** `device/cli-outcomes.test.ts › ends the drain on a renewal that ends locally, keeping the answers before it and the write it met`.

### `cli/command-renewal-signed-out`

When a drain ends because renewing the credential finds the person signed out, the CLI MUST report `signed_out` with `server` null and exit 5.

**Reason:** the error says the sign-in on this machine has ended, which is not a server's answer to the write.

**Tests:** `device/cli-outcomes.test.ts › ends the drain on a renewal that ends locally, keeping the answers before it and the write it met`.

## Held open

### `cli/command-follow-interrupted`

When `follow` is interrupted, the CLI MUST end it with its report, as when its time is up.

**Tests:** `device/catch-up.test.ts › prints its report when interrupted, as it does when its time is up`.

### `cli/command-follow-reader-gone`

When the reader of `follow`'s output has gone, the CLI MUST end the follow.

**Tests:** `device/catch-up.test.ts › ends a follow whose reader has gone, rather than going on untold`.

## Watched

### `cli/command-watch-failed`

If a watch fails, then the CLI MUST end `watch` with the error that failed it.

**Reason:** no hydration or catch-up in the command's own process would start the watch again.

**Tests:** `device/watch.test.ts › tells the server is reachable when the stream ends on the server's own answer, then that it failed`.

### `cli/reader-watch-no-hydration-hint`

While a store is opened to read, when a caller runs `device watch` before a first hydration, the CLI MUST omit the hint to hydrate first.

**Reason:** a reader watches local saves without holding the writer handle or asking the server, so hydration is not needed.

**Tests:** `device/reader-watch-live.test.ts › tells a never-hydrated reader about a concurrent save without a hydration warning or server contact`.

## Stopping a long call

### `cli/command-stopped-exit`

When a hydration, a catch-up or a drain that the CLI stopped on Ctrl-C ends `canceled`, the CLI MUST exit with status 3.

**Tests:** `device/stop.test.ts › ends it between pages, leaving a copy marked partial and a queue that is as it was`, `› ends it while it waits on a stream, keeping the cursor it had`, `› ends it without waiting on the write in flight, which the next drain sends again under its key`.

### `cli/command-second-ctrl-c`

When the CLI receives a second Ctrl-C before the call has stopped, the CLI MUST end the process at once with status 130.

**Tests:** `device/stop.test.ts › ends the process on a second Ctrl-C, where a first one waits for the call to notice`.

### `cli/command-changes-interrupted`

When `marfa device changes` is interrupted after it reports that it is watching, the CLI MUST end it with status 130.

**Reason:** a helper that is told to stop is not one whose time ran out, which ends with status 0, and a caller tells the two apart by the status.

**Tests:** `device/working-copy.test.ts › ends a changes helper with status 130 when interrupted, where one whose time is up ends with 0`.

## Terminal output

The CLI draws bold and color for the lines a person reads, on a terminal.

### `cli/no-escape-off-terminal`

If a standard stream of the CLI is not a terminal, or `NO_COLOR` is set and not empty, or `TERM` is `dumb`, or `--json` is given, then the CLI MUST write no escape character (U+001B) of its own to that stream.

**Reason:** An agent runs the CLI with no terminal and reads whatever it is sent, up to a limit, and a character that moves a cursor or sets a color is noise to it. Each stream is judged on its own, and a color never carries a meaning its words do not. The fixtures give the CLI no terminal, so the `NO_COLOR`, `TERM` and terminal halves are held by the CLI's own tests, which use a pseudo-terminal.

**Tests:** `device/contract.test.ts › writes no escape character to a stream that is not a terminal, with NO_COLOR set, or under --json`.

## Telemetry

The command line reports a run in two ways, and each has settings of its own: a trace over OTLP, and an exception report to error tracking. One being unset, or unusable, leaves the other as it was.

### `cli/cli-trace-endpoint`

When neither `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` nor `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the CLI MUST send no trace.

**Reason:** Some agent hosts remove every `OTEL_` setting from the shells they give an agent, and a trace needs a collector to go to.

**Tests:** `device/cli-exception-report.test.ts › sends one exception and no trace when only the error tracking settings are set`.

### `cli/cli-exception-report`

When `MARFA_POSTHOG_HOST` is an `https` address, or an `http` address on this machine, with no user name or password, `MARFA_POSTHOG_PROJECT_TOKEN` is set, `OTEL_SDK_DISABLED` is not `true`, and a command ends in a fault, the CLI MUST send one exception report, whatever the `OTEL_EXPORTER_OTLP_*` settings are.

**Reason:** An agent host that removes the `OTEL_` settings must not also silence the report of a fault, and an endpoint that cannot be used is the trace's trouble alone. A fault is what the command line or the core itself got wrong: a panic, including one the core caught and ended with the code `fault`; the local store failing for a reason of its own; an answer that cannot be read; or an answer status that the command line should never cause and that no refusal is named for, such as `405` or `415`.

**Tests:** `device/cli-exception-report.test.ts › sends one exception and no trace when only the error tracking settings are set`, `› still sends the exception when the OTLP endpoint is not an address`.

### `cli/cli-exception-refusal-quiet`

When a command ends in a refusal by design or in a failure of the server or the environment, the CLI MUST NOT send an exception report.

**Reason:** A refusal by design is an answer that works as intended: a `4xx` answer that names a refusal, a usage error, a missing credential or a missing docs page. A failure of the environment is one a retry can clear: offline, a timeout, a rate limit, a `408` or `425` answer, or full local storage. A `5xx` answer is the server's own failure, which the server reports itself, including a `503` `write_contention` or `stream_capacity_exhausted` and a `507` `insufficient_storage`. None tells error tracking about a fault in the command line or the core, and reporting them would bury the faults.

**Tests:** `device/cli-exception-report.test.ts › sends no exception when the command ends in a refusal by design`.

### `cli/cli-exception-success`

When a command succeeds, the CLI MUST NOT send an exception report.

**Tests:** `device/cli-exception-report.test.ts › sends no exception when the command succeeds`.

### `cli/cli-telemetry-disabled`

When `OTEL_SDK_DISABLED` is `true`, the CLI MUST send neither a trace nor an exception report.

**Tests:** `device/cli-exception-report.test.ts › sends nothing when the SDK is disabled, with an endpoint or without`.

## The docs site

`marfa docs` reads the public docs site, `https://docs.marfa.so` unless `MARFA_DOCS_URL` names another. The docs site is not a Marfa instance: the command needs no server, working copy or key to read it.

### `cli/docs-site`

When `marfa docs` sends a request, the CLI MUST send it to the address in `MARFA_DOCS_URL` where that holds more than white space, whatever `MARFA_API_URL` holds.

**Reason:** an agent can read the docs before it has a server, a working copy or a key.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `cli/docs-paths`

When `marfa docs` reads the docs site, the CLI MUST read a page from `/<path>.md`, a search from `/api/docs/search` and the list of pages from `/api/docs/topics`.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `cli/docs-no-credential`

When `marfa docs` sends a request to the docs site, the CLI MUST send no credential, whatever `MARFA_API_KEY` holds.

**Reason:** the docs site has no keys, so a credential sent to it would reach a host that never asked for one.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `cli/docs-no-contract`

When the docs site answers `marfa docs` naming no contract, the CLI MUST read the answer.

**Reason:** the docs site names no contract, so the check the CLI holds a server's answers to would refuse every page.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`.

### `cli/docs-page-missing`

If the docs site answers `404` for the page `marfa docs` is given, then the CLI MUST exit 1 with `docs_page_not_found`, naming the path.

**Reason:** a retry does not change a missing page. The message points to `marfa docs search`, where an agent that guessed a path can find the page it meant.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`, `› names the page a docs site does not hold, and the site that answers with a fault`.

### `cli/docs-unreachable`

If the docs site cannot be reached, or answers with a server fault or a status the CLI does not read, then the CLI MUST exit 3 with `docs_unreachable`, naming the site's address.

**Reason:** a refused connection, a read that timed out and a `5xx` are statements about the environment rather than about the page asked for, and clear without anybody doing anything.

**Tests:** `device/contract.test.ts › reads the docs site, which names no contract and is sent no credential`, `› names the page a docs site does not hold, and the site that answers with a fault`.

### `cli/docs-page-names`

When `marfa docs` is given a page by its path, with or without leading and trailing slashes, a leading `docs/`, a trailing `.md`, a query or a fragment, or by the whole `http` or `https` address of the page, the CLI MUST read the one page at `/<path>.md`.

**Tests:** `device/contract.test.ts › reads one docs page however it is named: with a slash, under docs/, with .md, or by its address`.

### `cli/docs-search-miss`

When `marfa docs search` receives no hit and `--json` is not given, the CLI MUST print that no page matches, then the titles and paths of the pages whose title, path or description hold words of the query when the docs site lists any, then the line "`marfa docs topics` lists every page.", and exit 0.

**Reason:** an agent that searched for a word the docs do not use has no next step in a bare "no match". A site that cannot list its pages still gets the plain miss, because the search itself succeeded.

**Tests:** `device/contract.test.ts › helps a docs search that finds nothing, and reads one section of a page`.

### `cli/docs-search-miss-json`

Where `--json` is given, when `marfa docs search` receives no hit, the CLI MUST print the answer of the docs site and send no request to `/api/docs/topics`.

**Reason:** the answer of a search keeps one shape whether or not it found something, and a script reading it asked for nothing else.

**Tests:** `device/contract.test.ts › helps a docs search that finds nothing, and reads one section of a page`.

### `cli/docs-section`

When `marfa docs` is given a page and `--section` with the text or the anchor of one of the page's Markdown headings, in any case, the CLI MUST print the page from that heading up to the next heading of the same depth or a higher one, and where `--json` is given, report that text in `markdown` and the heading asked for in `section`.

**Reason:** the changelog is longer than any agent needs to read to learn what one command does, and the site needs no change because the page is cut where it is read.

**Tests:** `device/contract.test.ts › helps a docs search that finds nothing, and reads one section of a page`.

### `cli/docs-section-missing`

If the page `marfa docs` is given has no heading named by `--section`, then the CLI MUST exit 1 with `docs_section_not_found`, naming the page and listing the page's headings.

**Reason:** a retry does not change a heading the page lacks, and the list is the next step for an agent that guessed the wording.

**Tests:** `device/contract.test.ts › helps a docs search that finds nothing, and reads one section of a page`.

### `cli/docs-json-refused`

If the docs site answers a success to `marfa docs search` with anything but a JSON object whose `hits` is an array of hits that each carry a `title` and a `url`, or to `marfa docs topics` with anything but a JSON object whose `pages` is an array of pages that each carry a `title` and a `url`, then the CLI MUST exit 3 with `decoding`, printing nothing to standard output.

**Reason:** an answer the CLI cannot read is not a refusal and not a lost connection, and printing it would pass a proxy's or a catch-all page's words off as the docs.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs search or topics answer that is not the JSON read, printing none of it`.

### `cli/docs-html`

If the docs site answers a page `marfa docs` asked for as `text/html`, then the CLI MUST exit 3 with `decoding`, printing nothing to standard output.

**Reason:** a site's catch-all page is never the page asked for.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs page served as HTML, printing none of it`.

### `cli/docs-too-large`

If the body of a success the docs site answers `marfa docs` with is larger than 10 MiB, which is 10,485,760 bytes, then the CLI MUST exit 3 with `decoding`, printing nothing to standard output.

**Reason:** a page or the list of pages is far smaller, so a body that large is not what the CLI asked for, and a retry does not change it. It is not `docs_unreachable`, which says the site may answer next time.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs answer larger than the command reads`.

### `cli/docs-not-utf8`

If the body of a success the docs site answers `marfa docs` with is not UTF-8, then the CLI MUST exit 3 with `decoding`, printing nothing to standard output.

**Tests:** `device/contract.test.ts › exits 3 with decoding for a docs page that is not UTF-8`.

### `cli/docs-redirect-followed`

When the docs site answers a request of `marfa docs` with a redirect that is no more than the fifth in a row, the CLI MUST follow it.

**Reason:** the docs site may move a page, and the CLI sends no credential for a redirect to carry to another host. A working copy follows no redirect from a server (`device/redirect-not-followed`).

**Tests:** `device/contract.test.ts › follows up to five redirects in a row from the docs site, and exits 3 with docs_unreachable past that`.

### `cli/docs-redirect-loop`

If the docs site answers more than five redirects in a row to one request of `marfa docs`, then the CLI MUST exit 3 with `docs_unreachable`.

**Reason:** more than five redirects in a row is a loop, which is the site failing.

**Tests:** `device/contract.test.ts › follows up to five redirects in a row from the docs site, and exits 3 with docs_unreachable past that`.

### `cli/docs-json-url`

Where `--json` is given, when `marfa docs` reads a page, the CLI MUST report in `url` the address it asked for, whether or not a redirect led it to another.

**Tests:** `device/contract.test.ts › reports the address a docs page was asked for, not the one a redirect led to`.

### `cli/docs-url-key`

If `--url`, `--key` or `--profile` is given to `marfa docs`, then the CLI MUST exit 2 with `usage` and send no request.

**Reason:** each names a Marfa server or a credential for it, and the docs site takes neither, so a person who gave one would believe it was used.

**Tests:** `device/contract.test.ts › refuses --url, --key and --profile on docs with usage, sending nothing`.

### `cli/docs-path-refused`

If the page `marfa docs` is given, once leading and trailing slashes, a leading `docs/`, a trailing `.md`, a query and a fragment are taken away, is not one or more segments divided by `/`, each of one or more ASCII letters, digits, `-`, `_`, `.` or `~` and neither `.` nor `..`, then the CLI MUST exit 1 with `invalid` and send no request.

**Reason:** a path outside that set could leave the docs site's pages or carry another request in its name.

**Tests:** `device/contract.test.ts › refuses a docs page path it does not accept with invalid, sending nothing`.

### `cli/docs-site-refused`

If `MARFA_DOCS_URL` holds more than white space and is not an `http` or `https` address with a host and no query or fragment, then the CLI MUST exit 1 with `invalid` and send no request.

**Tests:** `device/contract.test.ts › refuses a docs address that is not http or https with invalid, sending nothing`.

## A starting type definition

`marfa types scaffold` prints a definition for a type identifier and its fields. It names no server, working copy or key, and sends nothing.

### `cli/types-scaffold-prints`

When `marfa types scaffold` is given a type identifier, the CLI MUST print as JSON an object holding that `id`, the `parent` and `description` where given, and `fields` with one definition for each `--field`, in the order given, holding its `type`, `required: true` where `--required` names it, the `enum_values` of an `enum` and the `items_type` of an `array`.

**Tests:** `device/types-scaffold.test.ts › prints the id, the fields in the order given, the parent and the description`.

### `cli/types-scaffold-needs-nothing`

While no server, working copy or key is named, the CLI MUST print the definition `marfa types scaffold` is asked for.

**Reason:** an agent can write a definition before it has an instance to put it on.

**Tests:** `device/types-scaffold.test.ts › needs no server, working copy or key, and sends nothing where a server is named`.

### `cli/types-scaffold-offline`

When `marfa types scaffold` runs, the CLI MUST send no request, whatever `MARFA_API_URL` and `MARFA_API_KEY` hold and whether it prints a definition or refuses.

**Reason:** a definition is written on this machine, so naming a server must not make the command contact it.

**Tests:** `device/types-scaffold.test.ts › needs no server, working copy or key, and sends nothing where a server is named`, `› refuses --url, --key, --profile and --socket with usage, sending nothing`.

### `cli/types-scaffold-no-server-options`

If `marfa types scaffold` is given `--url`, `--key`, `--profile` or `--socket`, then the CLI MUST exit 2 with `usage`.

**Reason:** the command uses none of them, so a person who gave one would believe it was used.

**Tests:** `device/types-scaffold.test.ts › refuses --url, --key, --profile and --socket with usage, sending nothing`.

### `cli/types-scaffold-id-refused`

If the identifier `marfa types scaffold` is given breaks the type grammar (`types/id-grammar`), is under a root `types/id-reserved-scope-root` names, or is under `core`, `system` or `marfa` (`types/id-reserved-namespace`), then the CLI MUST exit 1 with `invalid`, naming the reason.

**Reason:** the server would refuse a registration of the identifier, so the definition printed for it would be one nothing could register.

**Tests:** `device/types-scaffold.test.ts › refuses an id the grammar or a reserved root refuses, naming the reason`.

### `cli/types-scaffold-field-name-refused`

If a `--field` of `marfa types scaffold` names a field an item has of its own (`types/field-shadows-item`), or a field already given, then the CLI MUST exit 1 with `invalid`, naming the reason.

**Tests:** `device/types-scaffold.test.ts › refuses a field name an item has and a name given twice`.

### `cli/types-scaffold-field-type-refused`

If a `--field` of `marfa types scaffold` gives a type outside the field grammar, an `enum` with no values, or an `array` with no element type (`types/field-grammar`), or an `array` whose element type is `thumbnail` (`types/thumbnail-name`), then the CLI MUST exit 1 with `invalid`, naming the reason.

**Tests:** `device/types-scaffold.test.ts › refuses a field type outside the grammar, an enum with no values, and an array with no element type or of thumbnails`.

### `cli/types-scaffold-thumbnail-refused`

If the fields of `marfa types scaffold` include a second `thumbnail` (`types/thumbnail-one`), or a `thumbnail` named `title`, `body`, `description` or `name` (`types/thumbnail-name`), then the CLI MUST exit 1 with `invalid`, naming the reason.

**Tests:** `device/types-scaffold.test.ts › refuses a second thumbnail and a thumbnail named for a field search reads`.

### `cli/types-scaffold-parent-refused`

If the `--parent` of `marfa types scaffold` breaks the type grammar or names the type itself, then the CLI MUST exit 1 with `invalid`, naming the reason.

**Tests:** `device/types-scaffold.test.ts › refuses a parent that breaks the grammar or is the type itself`.

### `cli/types-scaffold-parent-shape-refused`

If a `--field` of `marfa types scaffold` redeclares a field of a parent Marfa ships with another `type`, `format`, `items_type`, `searchable`, `max_length`, `max_items` or `enum_values`, or makes a field the parent requires optional (`types/child-shape`), then the CLI MUST exit 1 with `invalid`, naming the reason.

**Reason:** the server refuses such a subtype with `inheritance_violation`, so the definition would not register.

**Tests:** `device/types-scaffold.test.ts › refuses a field a shipped parent holds to another shape, or to be required`.

### `cli/types-scaffold-usage`

If a `--field` of `marfa types scaffold` is not `NAME:TYPE` or gives a third part to a type that takes none, or a `--required` names a field no `--field` gives, then the CLI MUST exit 2 with `usage`.

**Tests:** `device/types-scaffold.test.ts › refuses an option it cannot read with usage`.

### `cli/types-scaffold-declared`

The CLI MUST print, for `marfa types scaffold`, a definition that `marfa device types declare` takes unchanged.

**Reason:** a definition written for an app's working copy is declared as it stands.

**Tests:** `device/types-scaffold.test.ts › declares what it printed on a working copy, unchanged`.

### `cli/types-scaffold-registered`

The CLI MUST print, for `marfa types scaffold`, a definition that `marfa types register` registers unchanged where the key may register its identifier.

**Reason:** the command exists so that a definition is not written by hand, and one that needed editing before it registered would not save that.

**Tests:** `device/types-scaffold-live.test.ts › is registered unchanged by a key that may register its id, and by no other`.

## Normalizing a type definition

### `cli/normalize-cli`

When a caller runs `marfa types normalize` with a definition supplied by `--body`, `--file PATH` or `--file -`, the CLI MUST send the declared input to `POST /types/normalize` and return its answer.

**Tests:** `cli/doors.test.ts › normalizes an inline or stdin declaration with a read-only key and compares the registered definition`.

## The CLI's keys

### `cli/command-mint-nothing`

When `marfa keys create` runs with `--no-permissions`, the CLI MUST mint a key holding nothing in `permissions` and in each of the five maps.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

### `cli/command-update-nothing`

When `marfa keys update` runs with `--no-permissions`, the CLI MUST name `permissions` and every map empty, so the key holds nothing in any of them.

**Reason:** A key minted too wide is narrowed to nothing in place, rather than revoked and minted again.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

### `cli/command-update-one-map`

When `marfa keys update` runs with one `--no-<map>` option, the CLI MUST empty that map and leave every other family as it was.

**Tests:** `cli/instance.test.ts › empties one key permission map at a time and retains every other family`.

### `cli/command-expires-in`

When `marfa keys create` or `marfa keys update` runs with `--expires-in`, the CLI MUST send `expires_at` as the time on its own clock plus that duration.

**Reason:** The duration is the CLI's, measured on its own clock; the server holds only the time it is sent.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `cli/command-expires-at`

When `marfa keys create` or `marfa keys update` runs with `--expires-at`, the CLI MUST send that time as `expires_at`, as it was written.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `cli/command-no-expiry`

When `marfa keys update` runs with `--no-expiry`, the CLI MUST send `expires_at` as `null`.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `cli/command-expiry-duration`

If `marfa keys create` or `marfa keys update` runs with an `--expires-in` that is not a whole number above zero and one of the units `s`, `m`, `h`, `d` or `w`, then the CLI MUST exit 1 with the code `invalid` and send nothing.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `cli/command-expiry-conflict`

If `marfa keys create` or `marfa keys update` runs with both `--expires-in` and `--expires-at`, then the CLI MUST exit 2 with the code `usage`.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `cli/command-no-expiry-conflict`

If `marfa keys update` runs with `--no-expiry` and with `--expires-in` or `--expires-at`, then the CLI MUST exit 2 with the code `usage`.

**Tests:** `cli/instance.test.ts › mints a key with an expiry, changes and clears it, and a key past it is refused with exit 5`.

### `cli/command-revoked-key`

When the server refuses a request the CLI sends under a revoked key, the CLI MUST exit 5 and report `unauthorized`.

**Tests:** `cli/instance.test.ts › mints, lists, changes and revokes a key, and a revoked key is refused with exit 5`.

## What a key holds, in the approval pages' words

### `cli/access-words-cli`

Where the CLI prints what a key or an app holds in its readable output, the CLI MUST name each level of access it prints as "Read and edit", "Read only" or "No access", and each permission by the title the approval pages use.

**Tests:** `cli/access-words.test.ts › prints what a key holds in the words the approval pages use`.

## Bin commands

### `cli/owner-trash-cli`

When a caller runs `marfa --socket PATH items bin list` or `items bin empty`, or `items trash`, `items restore` or `items purge` with the item and its `--version`, the CLI MUST use the corresponding operation through private local authority.

**Tests:** `cli/item-summaries.test.ts › manages trash through local authority with summary responses`, `device/contract.test.ts › holds every bin command to the contract through its private socket`.

### `cli/owner-empty-bin-cli`

When a caller runs `marfa --socket PATH items bin empty --confirm PURGE`, the CLI MUST send each batch's `next_cursor` back to `POST /trash/empty` until the server names none.

**Reason:** the server deletes at most 200 items at a time, so a person with a bigger bin would otherwise copy a cursor between runs.

**Tests:** `cli/item-summaries.test.ts › sends each batch's cursor back until the server names none, so a bin of more than 200 empties in one command`.

### `cli/owner-empty-bin-progress`

When a caller runs `marfa --socket PATH items bin empty --confirm PURGE` without `--json`, the CLI MUST print how many items have been deleted so far after each batch that has a `next_cursor`, and the total at the end.

**Tests:** `cli/item-summaries.test.ts › prints how many items have been deleted so far after each batch that has another to follow, and the total at the end`.

### `cli/owner-empty-bin-json`

When a caller runs `marfa --socket PATH items bin empty --confirm PURGE --json`, the CLI MUST print one JSON object holding `purged`, `stayed` and `failures`.

**Tests:** `cli/item-summaries.test.ts › prints one JSON object of purged, stayed and failures under --json, with no line for a batch`.

### `cli/owner-empty-bin-exit`

When a caller runs `marfa --socket PATH items bin empty --confirm PURGE` and no deletion was left unconfirmed, the CLI MUST exit `0`.

**Tests:** `cli/item-summaries.test.ts › exits 0 when no deletion was left unconfirmed`.

### `cli/owner-empty-bin-unconfirmed`

If a batch of `marfa --socket PATH items bin empty --confirm PURGE` lists a deletion that could not be confirmed, then the CLI MUST exit with a code other than `0`.

**Tests:** `cli/item-summaries.test.ts › stops an uncertain bin emptying and exposes its outcome through the real socket CLI`.

## Item summaries

### `cli/owner-summaries-cli`

When a caller runs `marfa --socket PATH items summaries`, the CLI MUST send the optional `--type`, `--q`, `--limit` and `--cursor` filters to `GET /items/summaries` through private local authority and return its summary page.

**Tests:** `cli/item-summaries.test.ts › lists and searches names through local authority without item content`.

## Connector problems

### `cli/problems-cli`

When `marfa connectors list` returns a registration, the CLI MUST include its current problems.

**Tests:** `cli/connectors.test.ts › registers, heartbeats, reports a run, and is removed by the operator`.

## Export and restore

### `cli/cli-restore-refused`

When `POST /restore` refuses an archive that `marfa restore` sends, whether before the body or while it arrives, the CLI MUST report that refusal's status and code.

**Reason:** a person restoring a large archive learns why it was refused, not that a connection broke.

**Tests:** `cli/archive-blobs.test.ts › reports the refusal of a large archive the server refuses before or while it arrives`.

### `cli/cli-restore-not-restored`

When `POST /restore` answers `marfa restore` with `not_restored`, the CLI MUST print the `message` of each entry on its own line on standard error.

**Reason:** the person running the command learns there and then each thing that is not restored, and what to do about it.

**Tests:** `cli/restore-says.test.ts › prints one line on standard error for each kind a restore left out, and what it did with the settings`.

### `cli/cli-restore-previous-instance`

When `POST /restore` answers `marfa restore` with `previous_instance`, the CLI MUST print its `message` on standard error.

**Reason:** the person running the command learns where the old instance's backups stay, and that they may be deleted only once that instance no longer runs and nothing else restores from them.

**Tests:** `cli/restore-says.test.ts › prints one line on standard error for each kind a restore left out, and what it did with the settings`.

### `cli/cli-export-default`

When `marfa export` is given no `--format` and no `--state`, the CLI MUST export the whole archive, as `--format archive` does, the bin included.

**Reason:** a person who exports to keep their data and does not read the help gets every item, the bin included, the tables, the settings and the files, not the items alone. The server's own default leaves the bin out, and the CLI asks for it.

**Tests:** `cli/instance-archive.test.ts › exports the whole archive when no format is given, and the items as text only when asked`.

### `cli/cli-export-ndjson`

When `marfa export --format ndjson` is run, the CLI MUST export the items as NDJSON.

**Tests:** `cli/instance-archive.test.ts › exports the whole archive when no format is given, and the items as text only when asked`, `› exports as NDJSON to stdout and as an archive to a file`.

### `cli/cli-export-lacking`

When `marfa export --format archive` has received an archive whose `files.ndjson.gz` names files as `not_carried` or `lost`, the CLI MUST exit 1 with `blobs_missing`, naming up to ten of the blobs and counting the rest.

**Reason:** the exit says the archive is not a whole backup.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps the archive where it is, and still names the blobs, when the incomplete name cannot be taken`.

### `cli/cli-export-lacking-kept`

When `marfa export --format archive --output <path>` has received an archive whose `files.ndjson.gz` names files as `not_carried` or `lost`, if `<path>.incomplete` can be replaced, then the CLI MUST keep the whole archive at `<path>.incomplete`, replacing only an earlier file of that name.

**Reason:** the archive holds everything else, and may hold the only copy of a file the server has since lost, so it is kept where the person can get it back and is named as incomplete.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `cli/cli-export-lacking-refused`

When `marfa export --format archive --output <path>` has received an archive whose `files.ndjson.gz` names files as `not_carried` or `lost`, if `<path>.incomplete` cannot be replaced, then the CLI MUST keep the whole archive in a hidden partial file beside `<path>`.

**Reason:** the bytes are kept where the person can get them back, and the exit, the `blobs_missing` code and the hashes of `cli/cli-export-lacking` still reach the person.

**Tests:** `cli/archive-blobs.test.ts › keeps the archive where it is, and still names the blobs, when the incomplete name cannot be taken`.

### `cli/cli-export-refused-named`

When `marfa export --format archive --output <path>` has kept an archive that lacks blobs in a hidden partial file because `<path>.incomplete` cannot be replaced, the CLI MUST name that file and the reason in its message.

**Reason:** the person learns from the message alone where the archive is and why it is not at the incomplete name.

**Tests:** `cli/archive-blobs.test.ts › keeps the archive where it is, and still names the blobs, when the incomplete name cannot be taken`.

### `cli/cli-export-lacking-path`

When `marfa export --format archive --output <path>` has received an archive whose `files.ndjson.gz` names files as `not_carried` or `lost`, the CLI MUST NOT write to `<path>`.

**Reason:** a file at the path is the last complete backup when the command is run on a schedule, and a script that reads the path must never get an archive that lacks files. An earlier file stays byte for byte, and where none was, none is made.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `cli/cli-export-lacking-named`

When `marfa export --format archive --output <path>` has kept an archive that lacks blobs at `<path>.incomplete`, the CLI MUST name `<path>` and `<path>.incomplete` in its message.

**Reason:** the person learns from the message alone where the incomplete archive is.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `cli/cli-export-lacking-path-state`

When `marfa export --format archive --output <path>` has received an archive whose `files.ndjson.gz` names files as `not_carried` or `lost`, the CLI MUST say in its message whether `<path>` still holds an earlier file or was not written.

**Reason:** the person learns that the path was left alone, and whether a backup is still there.

**Tests:** `cli/archive-blobs.test.ts › keeps an archive that lacks a blob beside the path, exits 1 with blobs_missing, and leaves the earlier archive as it was`, `› keeps an archive that lacks a blob beside a path where nothing was, and says so`.

### `cli/cli-export-whole`

When `marfa export --output <path>` receives an export that ends whole and, for an archive, has a readable manifest followed by a readable `files.ndjson.gz` that names no file as `not_carried` or `lost`, the CLI MUST replace `<path>` with it.

**Reason:** the earlier backup is replaced only by one that is at least as complete.

**Tests:** `cli/archive-blobs.test.ts › replaces the path with a whole archive and leaves no other file`.

### `cli/cli-export-whole-clean`

When `marfa export --output <path>` replaces `<path>`, the CLI MUST leave no partial file beside it.

**Reason:** a file left behind would be mistaken by a later run, or a person, for a backup. An older `<path>.incomplete` is not a partial file of this run, and is left as it was.

**Tests:** `cli/archive-blobs.test.ts › replaces the path with a whole archive and leaves no other file`.

### `cli/cli-export-archive-wait`

When `marfa export --format archive` has sent its request, the CLI MUST wait up to 30 minutes for the server to begin its answer.

**Reason:** the server checks the whole selection before it sends an archive (`archive/archive-restorable`), so its first byte comes after a time that grows with the instance: about 4 seconds for 250,000 items on a fast computer at rest, and many times that on a small server that is busy, which can pass the 90 seconds the CLI gives most commands for an answer to begin. A bound that is too short ends the export of the instances that most need a backup, and the server then drops the request.

**Tests:** `cli/archive-wait.test.ts › waits for an archive whose first byte comes after the usual answer budget, says it is working, and writes the path once the archive ends whole`.

### `cli/cli-export-archive-working`

While `marfa export --format archive` waits for the server to begin its answer, the CLI MUST say on standard error, from the fifth second and every 15 seconds after, that it is still preparing the archive.

**Reason:** an export that says nothing for minutes looks like a hung command, and a person or a scheduler would end it.

**Tests:** `cli/archive-wait.test.ts › waits for an archive whose first byte comes after the usual answer budget, says it is working, and writes the path once the archive ends whole`.

### `cli/cli-restore-lacking`

When `POST /restore` answers `marfa restore` with hashes in `blobs_missing`, the CLI MUST print the answer and exit 1 with `blobs_missing`, naming up to ten of the blobs and counting the rest.

**Tests:** `cli/archive-blobs.test.ts › prints the answer of a restore of it and exits 1 with blobs_missing`.

### `cli/cli-export-cut`

If the stream of `marfa export --output <path>` ends early, then the CLI MUST leave the path as it was before the command and exit 3.

**Reason:** a file cut short at the path would pass for a backup until a restore needed it.

**Tests:** `cli/archive-blobs.test.ts › leaves the path as it was when the export is cut short, and the next export names the struck blob`.

### `cli/cli-export-cut-clean`

If the stream of `marfa export --output <path>` ends early, then the CLI MUST leave no partial file beside the path.

**Reason:** a file cut short, kept anywhere the person looks for backups, would pass for one. Only a process killed outright leaves its partial file, which no code can prevent.

**Tests:** `cli/archive-blobs.test.ts › leaves the path as it was when the export is cut short, and the next export names the struck blob`.
