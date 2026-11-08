# The machine that runs the x86_64 programs on a real kernel: QEMU and the few tools
# that pack the machine's files. Built by native/vm.sh, which gives it the base image
# from native/manifest.txt.
ARG BASE
FROM ${BASE}
RUN apk add --no-cache qemu-system-x86_64 \
 && qemu-system-x86_64 --version | head -1
