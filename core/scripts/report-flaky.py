#!/usr/bin/env python3
"""Names the tests that failed and then passed on a retry.

Reads the JUnit files nextest wrote under its `ci` profile, and writes a table
of the flaky tests to the job summary (`GITHUB_STEP_SUMMARY`) and a warning
annotation for each to the log. It prints nothing and exits 0 when no test was
flaky, and also when a file is missing: a run that never got as far as writing
one has failed in a way the run already shows.

A test that appears here more than once is filed as an issue and fixed.
"""
import os
import sys
import xml.etree.ElementTree as ET


def flaky_tests(path):
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError):
        return []
    found = []
    for case in root.iter("testcase"):
        marks = [
            child for child in case if child.tag in ("flakyFailure", "flakyError")
        ]
        if marks:
            found.append((case.get("classname", ""), case.get("name", ""), len(marks)))
    return found


def main(paths):
    found = [test for path in paths for test in flaky_tests(path)]
    if not found:
        return
    for binary, name, _ in found:
        print(f"::warning::flaky test, failed and then passed on retry: {binary} {name}")
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if not summary:
        return
    with open(summary, "a", encoding="utf-8") as out:
        out.write("### Flaky Rust tests (passed only on retry)\n\n")
        out.write("| Binary | Test | Failed attempts |\n| --- | --- | --- |\n")
        for binary, name, attempts in found:
            out.write(f"| `{binary}` | `{name}` | {attempts} |\n")
        out.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
