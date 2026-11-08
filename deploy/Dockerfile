# syntax=docker/dockerfile:1
#
# The Marfa server, from the release's own static Linux programs. Nothing is compiled
# here, so the image runs the bytes in the release's archives. The build context is
# a folder holding, for each platform, `amd64/` and `arm64/` with `marfa`,
# `marfa-server` and `NOTICES.txt`:
#
#   docker buildx build -f deploy/Dockerfile --platform linux/amd64 -t marfa-server <context>
#
# `release.yml` publishes it as `ghcr.io/withmarfa/marfa-server`.
#
# The base has CA certificates, a non-root user (65532) and `/tmp`, and no shell,
# package manager or libc. To move the pin, look up the digest of
# `gcr.io/distroless/static-debian12:nonroot` and replace it.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab

ARG TARGETARCH
ARG VERSION
ARG REVISION
ARG SOURCE=https://github.com/withmarfa/marfa

LABEL org.opencontainers.image.title="Marfa server" \
      org.opencontainers.image.description="The Marfa server." \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="Apache-2.0"

COPY --chmod=0755 ${TARGETARCH}/marfa ${TARGETARCH}/marfa-server /usr/local/bin/
COPY ${TARGETARCH}/NOTICES.txt /usr/share/doc/marfa/NOTICES.txt

# The server listens on every interface of the container; the volume mounted at /data
# holds the database, the files and the private control socket.
ENV MARFA_LISTEN_HOST=0.0.0.0 \
    PORT=8600 \
    SQLITE_PATH=/data/marfa.db \
    BLOB_PATH=/data/blobs \
    MARFA_CONTROL_SOCKET=/data/control/marfa.sock

USER 65532:65532
WORKDIR /data
EXPOSE 8600
# Asks `/health` of the server in this container, with no key. It follows `PORT`'s default.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/usr/local/bin/marfa", "--no-keychain", "--url", "http://127.0.0.1:8600", "status"]
# `marfa server run` supervises the server: a database the server refuses leaves the
# container up and idle, so a restart policy does not start it into the same refusal.
ENTRYPOINT ["/usr/local/bin/marfa", "server", "run"]
