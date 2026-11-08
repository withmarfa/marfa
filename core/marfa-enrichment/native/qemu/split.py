#!/usr/bin/env python3
"""Splits the serial console log of native/vm.sh into one result per case.

    split.py <serial.log> <results folder> <plan>

Writes <results>/<name>.stdout, .stderr and .code for every line of the plan, the
`vm:` lines about the machine to <results>/machine.txt, and stops with a message if
the machine did not answer every case.
"""
import os
import sys

log, results, plan = sys.argv[1:4]
expected = [line.split("\t")[2] for line in open(plan).read().splitlines()[1:] if line]
machine, done, seen = [], None, {}
with open(log, "rb") as handle:
    for raw in handle:
        line = raw.rstrip(b"\r\n").decode("utf-8", "replace")
        if line.startswith("@@marfa-vm-done "):
            done = int(line.split()[1])
        elif line.startswith("@@marfa-vm "):
            fields = line.split(" ")
            if len(fields) < 6:
                continue
            _, name, code, millis, out, err = fields[:6]
            seen[name] = (int(code), int(millis), bytes.fromhex(out), bytes.fromhex(err))
        elif line.startswith("vm: "):
            machine.append(line)
os.makedirs(results, exist_ok=True)
with open(os.path.join(results, "machine.txt"), "w") as handle:
    handle.write("\n".join(machine) + "\n")
for name, (code, millis, out, err) in seen.items():
    base = os.path.join(results, name)
    os.makedirs(os.path.dirname(base), exist_ok=True)
    open(base + ".stdout", "wb").write(out)
    open(base + ".stderr", "wb").write(err)
    open(base + ".code", "w").write(f"{code}\n")
    open(base + ".ms", "w").write(f"{millis}\n")
missing = [name for name in expected if name not in seen]
print("\n".join(machine))
if done != len(expected) or missing:
    print(f"split: the machine answered {len(seen)} of {len(expected)} cases (it said {done}); missing: {missing[:10]}", file=sys.stderr)
    sys.exit(1)
print(f"split: {len(seen)} cases answered")
