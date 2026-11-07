#!/bin/bash
# Runs the x86_64 programs on a real Linux kernel: a full-system QEMU that emulates an
# x86_64 PC, with nothing in it but the kernel, a first program (qemu/init.rs), the two
# programs and the test files. No x86_64 hardware is needed, and no Rosetta: the CPU is
# emulated, the kernel is real, so Landlock and seccomp are the kernel's own. It is slow,
# which is why verify.sh makes one boot run every case (verify.sh --vm).
#
#   MARFA_NATIVE_ROOT=<folder> native/vm.sh <folder of the VM> <folder of the programs>
#
# The folder of the VM holds `plan` (qemu/init.rs says what a line is), `files/` and
# `models/`. It gets the kernel, the packed machine, `serial.log` and `results/`.
#
# Optional settings: MARFA_VM_MEMORY (MiB, default 3072), MARFA_VM_CPUS (default 2),
# MARFA_VM_LIMIT (seconds for the whole machine, default 7200), MARFA_RELEASE_PREFIX
# (the names of the images, default marfa-release).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need docker python3
vm=${1:?the folder of the VM}
programs=${2:?the folder of the programs}
select_target x86_64-unknown-linux-musl
select_root
vm=$(cd "$vm" && pwd)
programs=$(cd "$programs" && pwd)
prefix=${MARFA_RELEASE_PREFIX:-marfa-release}
memory=${MARFA_VM_MEMORY:-3072}
cpus=${MARFA_VM_CPUS:-2}
limit=${MARFA_VM_LIMIT:-7200}
for needed in plan files models; do
  [ -e "$vm/$needed" ] || die "no $vm/$needed"
done
for program in marfa-enrichment-read marfa-enrichment-read-proof; do
  [ -x "$programs/$program" ] || die "no $programs/$program"
done

build_image="$prefix-build"
qemu_image="$prefix-qemu"

echo "vm: make the images"
make_build_image "$build_image"
docker build --quiet --build-arg "BASE=$(manifest_line image qemu | awk '{ print $3 }')" \
  -t "$qemu_image" "$NATIVE_DIR/qemu" >/dev/null || die "could not build $qemu_image"

echo "vm: fetch the kernel"
read -r _kind kernel_name kernel_url kernel_sha <<<"$(manifest_line kernel debian-6.1.0-28-cloud-amd64)"
download "$kernel_url" "$kernel_sha" "$DOWNLOADS/$kernel_name.deb"

echo "vm: build the first program"
rm -f "$vm/init" "$vm/vmlinuz" "$vm/initramfs.gz" "$vm/serial.log"
rm -rf "$vm/results"
docker run --rm --platform linux/amd64 -v "$NATIVE_DIR/qemu:/src:ro" -v "$vm:/vm" "$build_image" \
  rustc --edition 2024 --target x86_64-unknown-linux-musl -C opt-level=2 -C panic=abort \
  -C strip=symbols -o /vm/init /src/init.rs || die "could not build qemu/init.rs"

echo "vm: unpack the kernel and pack the machine"
python3 -I "$NATIVE_DIR/qemu/kernel.py" "$DOWNLOADS/$kernel_name.deb" "$vm/vmlinuz" || die "could not unpack the kernel"
docker run --rm -v "$programs:/programs:ro" -v "$vm:/vm" "$qemu_image" sh -ec '
  root=/tmp/root
  mkdir -p $root/dev $root/proc $root/scratch $root/files $root/models
  cp /vm/init $root/init
  cp /programs/marfa-enrichment-read /programs/marfa-enrichment-read-proof $root/
  cp -a /vm/files/. $root/files/
  cp -a /vm/models/. $root/models/
  cp /vm/plan $root/plan
  chown -R 0:0 $root
  chmod -R a+rX $root/files
  chmod 755 $root/init $root/marfa-enrichment-read $root/marfa-enrichment-read-proof
  mknod -m 600 $root/dev/console c 5 1
  mknod -m 666 $root/dev/null c 1 3
  (cd $root && find . | cpio -o -H newc 2>/dev/null) | gzip -1 >/vm/initramfs.gz
' || die "could not pack the machine"

echo "vm: boot (an emulated x86_64 PC, ${cpus} CPUs, ${memory} MiB, limit ${limit} s)"
started=$SECONDS
docker run --rm --name "$prefix-vm" -v "$vm:/vm" "$qemu_image" timeout "$limit" \
  qemu-system-x86_64 -machine q35 -cpu max -smp "$cpus" -m "$memory" \
  -kernel /vm/vmlinuz -initrd /vm/initramfs.gz \
  -append "console=ttyS0 quiet loglevel=0 panic=-1 rdinit=/init" \
  -display none -serial stdio -monitor none -no-reboot </dev/null >"$vm/serial.log" || true
echo "vm: the machine ran $((SECONDS - started)) seconds"
docker run --rm "$qemu_image" qemu-system-x86_64 --version | head -1

python3 -I "$NATIVE_DIR/qemu/split.py" "$vm/serial.log" "$vm/results" "$vm/plan"
