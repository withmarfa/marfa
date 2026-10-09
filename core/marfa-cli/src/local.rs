use crate::error::CliError;
use std::io::{Read, Write};
use std::os::unix::{fs::MetadataExt, net::UnixStream};
use std::path::{Path, PathBuf};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, Transport,
};

pub fn http(path: &Path) -> Result<marfa_core::http::Http, CliError> {
    verify(path)?;
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .proxy(None)
        .timeout_recv_response(Some(std::time::Duration::from_secs(90)))
        .timeout_recv_body(Some(std::time::Duration::from_secs(90)))
        .build();
    let path = path.to_owned();
    Ok(marfa_core::http::Http::with_connector(
        "http://127.0.0.1",
        "",
        config,
        move || LocalConnector(path.clone()),
    )?)
}

fn verify(path: &Path) -> Result<(), CliError> {
    if !path.is_absolute() {
        return Err(CliError::Invalid(
            "--socket requires an absolute path".into(),
        ));
    }
    let uid = unsafe { libc::geteuid() };
    let mut current = PathBuf::new();
    for component in path.components() {
        if !matches!(
            component,
            std::path::Component::RootDir | std::path::Component::Normal(_)
        ) {
            return Err(CliError::Invalid(
                "--socket requires a normalized absolute path".into(),
            ));
        }
        current.push(component);
        let metadata = std::fs::symlink_metadata(&current)?;
        let output = if cfg!(target_os = "macos") {
            std::process::Command::new("/bin/ls")
                .arg("-lde")
                .arg(&current)
                .output()?
        } else {
            std::process::Command::new("getfacl")
                .args(["--absolute-names", "--omit-header"])
                .arg(&current)
                .output()?
        };
        if !output.status.success() {
            return Err(CliError::Invalid(
                "cannot verify the socket path ACL".into(),
            ));
        }
        let acl = String::from_utf8_lossy(&output.stdout);
        let unsafe_acl = if cfg!(target_os = "macos") {
            acl.lines()
                .skip(1)
                .any(|line| line.split_whitespace().any(|word| word == "allow"))
        } else {
            acl.lines().any(|line| {
                line.starts_with("default:")
                    || (line.starts_with("user:") && !line.starts_with("user::"))
                    || (line.starts_with("group:") && !line.starts_with("group::"))
            })
        };
        if unsafe_acl {
            return Err(CliError::Invalid(
                "the socket path has an access ACL".into(),
            ));
        }

        if metadata.file_type().is_symlink() {
            return Err(CliError::Invalid(
                "--socket must not traverse symbolic links".into(),
            ));
        }
        if current == path || Some(current.as_path()) == path.parent() {
            let expected = if current == path { 0o600 } else { 0o700 };
            if metadata.uid() != uid || metadata.mode() & 0o777 != expected {
                return Err(CliError::Invalid("the socket must be owned by this account with mode 0600, in an owned directory with mode 0700".into()));
            }
        } else if metadata.uid() != uid && metadata.uid() != 0
            || metadata.mode() & 0o022 != 0
                && !(metadata.uid() == 0 && metadata.mode() & 0o1000 != 0)
        {
            return Err(CliError::Invalid(
                "the socket path is writable by another account".into(),
            ));
        }
    }
    Ok(())
}

#[derive(Debug)]
struct LocalConnector(PathBuf);
impl Connector for LocalConnector {
    type Out = LocalTransport;
    fn connect(
        &self,
        _: &ConnectionDetails,
        _: Option<()>,
    ) -> Result<Option<Self::Out>, ureq::Error> {
        Ok(Some(LocalTransport {
            stream: UnixStream::connect(&self.0)?,
            buffers: LazyBuffers::new(16_384, 16_384),
        }))
    }
}
#[derive(Debug)]
struct LocalTransport {
    stream: UnixStream,
    buffers: LazyBuffers,
}
impl LocalTransport {
    fn set_read_timeout(&self, timeout: Option<std::time::Duration>) -> std::io::Result<()> {
        let result = self.stream.set_read_timeout(timeout);
        #[cfg(target_os = "macos")]
        if result
            .as_ref()
            .is_err_and(|error| error.raw_os_error() == Some(libc::EINVAL))
        {
            use std::os::fd::AsRawFd;
            let mut poll = libc::pollfd {
                fd: self.stream.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // macOS rejects socket timeout changes after the peer closes, even
            // when its response is still buffered. A hung-up socket cannot wait.
            if unsafe { libc::poll(&mut poll, 1, 0) } == 1 && poll.revents & libc::POLLHUP != 0 {
                return Ok(());
            }
        }
        result
    }
}

impl Transport for LocalTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }
    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream
            .set_write_timeout(timeout.not_zero().map(|t| *t))?;
        self.stream.write_all(&self.buffers.output()[..amount])?;
        Ok(())
    }
    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.set_read_timeout(timeout.not_zero().map(|t| *t))?;
        let amount = self.stream.read(self.buffers.input_append_buf())?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }
    fn is_open(&mut self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::{Remote, request::Request};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    #[test]
    fn local_transport_reaches_the_socket_without_authorization() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("marfa-local-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let serving = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let size = socket.read(&mut buffer).unwrap();
            let text = String::from_utf8_lossy(&buffer[..size]);
            assert!(text.starts_with("GET /_control/setup/status "), "{text}");
            assert!(!text.to_lowercase().contains("authorization:"));
            let body = r#"{"claimed":false}"#;
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nX-Marfa-Contract: {}\r\nConnection: close\r\n\r\n{}",body.len(),marfa_core::contract::CONTRACT_VERSION,body).unwrap();
        });
        let result = Remote::local(&path)
            .unwrap()
            .json(&Request::get(&["_control", "setup", "status"]))
            .unwrap();
        assert_eq!(result["claimed"], false);
        serving.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_streamed_request_reaches_the_socket_without_authorization() {
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("marfa-local-stream-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.join("control.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let serving = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0; 4096];
            let size = socket.read(&mut buffer).unwrap();
            let text = String::from_utf8_lossy(&buffer[..size]);
            assert!(text.starts_with("GET /blobs/sha256:abc "), "{text}");
            assert!(!text.to_lowercase().contains("authorization:"));
            let body = "streamed bytes";
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nX-Marfa-Contract: {}\r\nConnection: close\r\n\r\n{}",body.len(),marfa_core::contract::CONTRACT_VERSION,body).unwrap();
        });
        let (content_type, mut reader) = Remote::local(&path)
            .unwrap()
            .stream(&Request::get(&["blobs", "sha256:abc"]).streamed())
            .unwrap();
        let mut bytes = String::new();
        reader.read_to_string(&mut bytes).unwrap();
        assert_eq!(content_type, "application/octet-stream");
        assert_eq!(bytes, "streamed bytes");
        serving.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    fn input_timeout() -> NextTimeout {
        NextTimeout {
            after: std::time::Duration::from_millis(20).into(),
            reason: ureq::Timeout::RecvResponse,
        }
    }

    #[test]
    fn local_transport_drains_a_complete_response_after_the_peer_closes() {
        let (stream, mut peer) = UnixStream::pair().unwrap();
        let body = "x".repeat(4096);
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        peer.write_all(response.as_bytes()).unwrap();
        drop(peer);
        let mut transport = LocalTransport {
            stream,
            buffers: LazyBuffers::new(1024, 1024),
        };
        let mut received = Vec::new();
        while transport.await_input(input_timeout()).unwrap() {
            let input = transport.buffers.input();
            let amount = input.len();
            received.extend_from_slice(input);
            transport.buffers.input_consume(amount);
        }
        assert_eq!(received, response.as_bytes());
        assert!(transport.buffers.input().is_empty());
    }

    #[test]
    fn local_transport_reports_eof_when_the_peer_closes_without_a_response() {
        let (stream, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let mut transport = LocalTransport {
            stream,
            buffers: LazyBuffers::new(1024, 1024),
        };
        assert!(!transport.await_input(input_timeout()).unwrap());
        assert!(transport.buffers.input().is_empty());
    }

    #[test]
    fn local_transport_still_times_out_while_an_open_peer_is_silent() {
        let (stream, _peer) = UnixStream::pair().unwrap();
        let mut transport = LocalTransport {
            stream,
            buffers: LazyBuffers::new(1024, 1024),
        };
        let error = transport.await_input(input_timeout()).unwrap_err();
        assert!(
            matches!(error, ureq::Error::Io(ref io) if matches!(io.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)),
            "{error}"
        );
        assert!(transport.buffers.input().is_empty());
    }

    #[test]
    fn local_transport_preserves_invalid_timeout_errors_after_the_peer_closes() {
        let (stream, peer) = UnixStream::pair().unwrap();
        drop(peer);
        let transport = LocalTransport {
            stream,
            buffers: LazyBuffers::new(1024, 1024),
        };
        assert_eq!(
            transport
                .set_read_timeout(Some(std::time::Duration::ZERO))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidInput
        );
    }

    #[test]
    fn local_transport_never_falls_back_when_socket_is_absent() {
        assert!(Remote::local(Path::new("/no-such-marfa-control/control.sock")).is_err());
    }
}
