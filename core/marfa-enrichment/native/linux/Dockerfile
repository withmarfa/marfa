# The image every Linux build of the native readers runs in. Build it with
# native/release.sh, which gives it the base image and snapshot date from
# native/manifest.txt:
#
#   docker build --platform linux/amd64 --build-arg BASE=<image@digest> \
#     --build-arg SNAPSHOT=<timestamp> -f native/linux/Dockerfile native
ARG BASE
FROM --platform=linux/amd64 ${BASE}
ARG SNAPSHOT

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

# Packages come from the Ubuntu archive as it stood on one day. The base image has
# no certificates yet, so the first install does not check the archive's TLS
# certificate; apt checks the signature of every package list instead.
RUN rm -f /etc/apt/sources.list /etc/apt/sources.list.d/* \
 && printf 'Types: deb\nURIs: https://snapshot.ubuntu.com/ubuntu/%s\nSuites: noble noble-updates noble-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n' "$SNAPSHOT" \
      > /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get -o Acquire::https::Verify-Peer=false update \
 && apt-get -o Acquire::https::Verify-Peer=false install -y --no-install-recommends ca-certificates \
 && apt-get install -y --no-install-recommends \
      binutils build-essential cmake curl file git ninja-build patch pkg-config \
      python3 xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Rust, from the standalone installers the manifest pins, with the standard
# libraries of both Linux targets.
COPY lib.sh manifest.txt /native/
COPY linux/install-rust.sh /native/linux/
RUN /native/linux/install-rust.sh /opt/rust

ENV PATH=/opt/rust/bin:$PATH
