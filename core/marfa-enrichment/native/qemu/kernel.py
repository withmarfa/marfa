#!/usr/bin/env python3
"""Takes the kernel image out of a Debian kernel package.

    kernel.py <package.deb> <output file>

A .deb is an ar archive. Its data.tar.xz holds /boot/vmlinuz-<version>.
"""
import io
import lzma
import sys
import tarfile

deb, output = sys.argv[1:3]
data = open(deb, "rb").read()
if data[:8] != b"!<arch>\n":
    sys.exit(f"kernel: {deb} is not an ar archive")
position, members = 8, {}
while position + 60 <= len(data):
    name = data[position : position + 16].decode().strip().rstrip("/")
    size = int(data[position + 48 : position + 58])
    start = position + 60
    members[name] = data[start : start + size]
    position = start + size + (size & 1)
if "data.tar.xz" not in members:
    sys.exit(f"kernel: no data.tar.xz in {deb}")
with tarfile.open(fileobj=io.BytesIO(lzma.decompress(members["data.tar.xz"]))) as archive:
    images = [m for m in archive.getmembers() if m.isfile() and "/boot/vmlinuz-" in m.name]
    if len(images) != 1:
        sys.exit(f"kernel: expected one kernel image, found {[m.name for m in images]}")
    open(output, "wb").write(archive.extractfile(images[0]).read())
print(f"kernel: {images[0].name}")
