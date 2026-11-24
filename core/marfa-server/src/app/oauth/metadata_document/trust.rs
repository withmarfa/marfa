//! The `trust:<host>` test fault: a connection to that host accepts one certificate, byte for byte.

use std::io::{Read, Write};
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::verify_server_name;
use rustls::crypto::{WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::server::ParsedCertificate;
use rustls::{
    CertificateError, ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme,
    StreamOwned,
};
use ureq::unversioned::transport::time::{Duration, Instant};
use ureq::unversioned::transport::{
    Buffers, ConnectionDetails, Connector, LazyBuffers, NextTimeout, TcpConnector, Transport,
    TransportAdapter,
};
use x509_parser::certificate::X509Certificate;
use x509_parser::prelude::FromDer;

/// Connects over TCP and then TLS, accepting only `certificate` as the server's.
pub(super) fn connector(
    certificate: CertificateDer<'static>,
) -> Result<impl Connector, ureq::Error> {
    Ok(
        ().chain(TcpConnector::default())
            .chain(handshake(certificate)?),
    )
}

fn handshake(certificate: CertificateDer<'static>) -> Result<Handshake, ureq::Error> {
    let provider = rustls::crypto::ring::default_provider();
    let algorithms = provider.signature_verification_algorithms;
    let config = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Exactly {
            certificate,
            algorithms,
        }))
        .with_no_client_auth();
    Ok(Handshake(Arc::new(config)))
}

/// The pinned certificate stands in for the chain to a root; everything production checks of the
/// end entity itself still holds.
#[derive(Debug)]
struct Exactly {
    certificate: CertificateDer<'static>,
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for Exactly {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() != self.certificate.as_ref() {
            return Err(rustls::Error::InvalidCertificate(
                CertificateError::UnknownIssuer,
            ));
        }
        verify_server_name(&ParsedCertificate::try_from(end_entity)?, server_name)?;
        serves_now(end_entity, now).map_err(rustls::Error::InvalidCertificate)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// The end-entity checks webpki makes before it looks for an issuer: the validity period, no CA
/// flag, and server authentication among the extended key usages when they are listed.
fn serves_now(end_entity: &CertificateDer<'_>, now: UnixTime) -> Result<(), CertificateError> {
    let (_, certificate) = X509Certificate::from_der(end_entity.as_ref())
        .map_err(|_| CertificateError::BadEncoding)?;
    let now = i64::try_from(now.as_secs()).map_err(|_| CertificateError::Expired)?;
    let validity = certificate.validity();
    if now < validity.not_before.timestamp() {
        return Err(CertificateError::NotValidYet);
    }
    if now > validity.not_after.timestamp() {
        return Err(CertificateError::Expired);
    }
    let constraints = certificate
        .basic_constraints()
        .map_err(|_| CertificateError::BadEncoding)?;
    if constraints.is_some_and(|constraints| constraints.value.ca) {
        return Err(CertificateError::InvalidPurpose);
    }
    let usages = certificate
        .extended_key_usage()
        .map_err(|_| CertificateError::BadEncoding)?;
    if usages.is_some_and(|usages| !usages.value.server_auth) {
        return Err(CertificateError::InvalidPurpose);
    }
    Ok(())
}

/// `timeout` counted from `started` rather than from now.
fn remaining(mut timeout: NextTimeout, started: Instant, now: Instant) -> NextTimeout {
    if let (Duration::Exact(limit), Instant::Exact(started), Instant::Exact(now)) =
        (timeout.after, started, now)
    {
        timeout.after =
            Duration::Exact(limit.saturating_sub(now.saturating_duration_since(started)));
    }
    timeout
}

#[derive(Debug)]
struct Handshake(Arc<ClientConfig>);

impl<In: Transport> Connector<In> for Handshake {
    type Out = Tls;

    fn connect(
        &self,
        details: &ConnectionDetails,
        chained: Option<In>,
    ) -> Result<Option<Tls>, ureq::Error> {
        let Some(transport) = chained else {
            return Ok(None);
        };
        let host = details
            .uri
            .host()
            .ok_or(ureq::Error::Tls("no host to connect to"))?;
        let name = ServerName::try_from(host.to_string())
            .map_err(|_| ureq::Error::Tls("not a host name"))?;
        let mut connection = ClientConnection::new(self.0.clone(), name)?;
        let mut socket = TransportAdapter::new(transport.boxed(), details.current_time.clone());
        socket.set_timeout(remaining(
            details.timeout,
            details.now,
            (details.current_time)(),
        ));
        connection.complete_io(&mut socket)?;
        Ok(Some(Tls {
            buffers: LazyBuffers::new(
                details.config.input_buffer_size(),
                details.config.output_buffer_size(),
            ),
            stream: StreamOwned::new(connection, socket),
        }))
    }
}

struct Tls {
    buffers: LazyBuffers,
    stream: StreamOwned<ClientConnection, TransportAdapter>,
}

impl std::fmt::Debug for Tls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Tls").finish_non_exhaustive()
    }
}

impl Transport for Tls {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }

    fn transmit_output(&mut self, amount: usize, timeout: NextTimeout) -> Result<(), ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let output = &self.buffers.output()[..amount];
        self.stream.write_all(output)?;
        Ok(())
    }

    fn await_input(&mut self, timeout: NextTimeout) -> Result<bool, ureq::Error> {
        self.stream.get_mut().set_timeout(timeout);
        let input = self.buffers.input_append_buf();
        let amount = self.stream.read(input)?;
        self.buffers.input_appended(amount);
        Ok(amount > 0)
    }

    fn is_open(&mut self) -> bool {
        self.stream.get_mut().get_mut().is_open()
    }

    fn is_tls(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::time::{Duration, Instant};

    use ureq::Agent;

    use super::*;
    use crate::app::outbound::Pinned;

    /// Passes the connection on after a pause, as a slow connect would.
    #[derive(Debug)]
    struct Slow(Duration);

    impl<In: Transport> Connector<In> for Slow {
        type Out = In;

        fn connect(
            &self,
            _details: &ConnectionDetails,
            chained: Option<In>,
        ) -> Result<Option<In>, ureq::Error> {
            std::thread::sleep(self.0);
            Ok(chained)
        }
    }

    #[test]
    fn the_handshake_ends_within_the_connections_deadline() {
        let limit = Duration::from_millis(1000);
        // The kernel completes TCP connects to a listener that never answers TLS.
        let silent = TcpListener::bind("127.0.0.1:0").expect("a port");
        let address = silent.local_addr().expect("an address");
        let certificate = rcgen::generate_simple_self_signed(vec!["a.test".to_string()])
            .expect("a certificate")
            .cert
            .der()
            .clone();
        let config = Agent::config_builder().timeout_global(Some(limit)).build();
        let connector =
            ().chain(TcpConnector::default())
                .chain(Slow(Duration::from_millis(600)))
                .chain(handshake(certificate).expect("a handshake"));
        let agent = Agent::with_parts(config, connector, Pinned(vec![address]));
        let started = Instant::now();
        let outcome = agent
            .get(&format!("https://a.test:{}/", address.port()))
            .call();
        let elapsed = started.elapsed();
        assert!(outcome.is_err());
        assert!(elapsed < limit + Duration::from_millis(300), "{elapsed:?}");
        drop(silent);
    }
}
