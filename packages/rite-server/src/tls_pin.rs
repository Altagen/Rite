//! TLS certificate pinning for the context multiplexer (ADR 0012 phase 4).
//!
//! The local server connects to a remote over TLS. A **real** cert validates via
//! webpki roots (nothing for the user to do). A **self-signed** cert is trusted
//! by TOFU: the fingerprint is pinned in the roster and later connects must
//! match it. Two verifiers:
//! - `PinnedVerifier` — the proxy: accept if the leaf SHA-256 matches the active
//!   pin, else fall back to webpki. (Unpinned self-signed → rejected.)
//! - `CaptureVerifier` — the probe only: accept anything, but record the leaf
//!   fingerprint + whether webpki would have accepted it, so the UI can show the
//!   fingerprint for out-of-band confirmation before pinning.

use std::sync::{Arc, Mutex};

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::ring::default_provider;
use rustls::{ClientConfig, DigitallySignedStruct, Error, RootCertStore, SignatureScheme};
use rustls_pki_types::{CertificateDer, ServerName, UnixTime};
use sha2::{Digest, Sha256};

/// Lowercase hex SHA-256 of a DER certificate.
pub fn cert_fingerprint(cert: &CertificateDer<'_>) -> String {
    Sha256::digest(cert.as_ref())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn webpki() -> Arc<WebPkiServerVerifier> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // Use the explicit ring provider (not the process default, which the unit
    // tests never install) to enumerate supported signature algorithms.
    WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::new(default_provider()))
        .build()
        .expect("build webpki verifier")
}

/// Proxy verifier: pin-match OR webpki.
#[derive(Debug)]
pub struct PinnedVerifier {
    pin: Arc<Mutex<Option<String>>>,
    webpki: Arc<WebPkiServerVerifier>,
}

impl PinnedVerifier {
    pub fn new(pin: Arc<Mutex<Option<String>>>) -> Arc<Self> {
        Arc::new(Self {
            pin,
            webpki: webpki(),
        })
    }
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if let Some(pin) = self.pin.lock().unwrap().as_deref()
            && pin.eq_ignore_ascii_case(&cert_fingerprint(end_entity))
        {
            return Ok(ServerCertVerified::assertion());
        }
        self.webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.webpki.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        self.webpki.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

/// Probe verifier: accepts anything, records (fingerprint, webpki-trusted).
#[derive(Debug)]
pub struct CaptureVerifier {
    captured: Arc<Mutex<Option<(String, bool)>>>,
    webpki: Arc<WebPkiServerVerifier>,
}

impl CaptureVerifier {
    pub fn new(captured: Arc<Mutex<Option<(String, bool)>>>) -> Arc<Self> {
        Arc::new(Self {
            captured,
            webpki: webpki(),
        })
    }
}

impl ServerCertVerifier for CaptureVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let fp = cert_fingerprint(end_entity);
        let trusted = self
            .webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
            .is_ok();
        *self.captured.lock().unwrap() = Some((fp, trusted));
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.webpki.supported_verify_schemes()
    }
}

/// Build a rustls `ClientConfig` with a custom cert verifier (explicit ring
/// provider, so it doesn't depend on a process-installed default).
pub fn client_config(verifier: Arc<dyn ServerCertVerifier>) -> ClientConfig {
    ClientConfig::builder_with_provider(Arc::new(default_provider()))
        .with_safe_default_protocol_versions()
        .expect("rustls protocol versions")
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verify(v: &dyn ServerCertVerifier, cert: &CertificateDer<'_>) -> Result<(), Error> {
        let name = ServerName::try_from("example.com").unwrap();
        v.verify_server_cert(cert, &[], &name, &[], UnixTime::now())
            .map(|_| ())
    }

    #[test]
    fn fingerprint_is_sha256_hex() {
        // Known vector: SHA-256 of the empty input.
        let empty = CertificateDer::from(Vec::new());
        assert_eq!(
            cert_fingerprint(&empty),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn matching_pin_is_accepted_without_webpki() {
        // Arbitrary (non-chaining) cert bytes: only the pin match can accept them.
        let cert = CertificateDer::from(b"not-a-real-cert".to_vec());
        let pin = Arc::new(Mutex::new(Some(cert_fingerprint(&cert))));
        let v = PinnedVerifier::new(pin);
        assert!(verify(v.as_ref(), &cert).is_ok());
    }

    #[test]
    fn wrong_or_absent_pin_falls_through_to_webpki() {
        let cert = CertificateDer::from(b"not-a-real-cert".to_vec());
        // Wrong pin → webpki rejects the self-signed/garbage cert.
        let wrong = Arc::new(Mutex::new(Some("00".repeat(32))));
        assert!(verify(PinnedVerifier::new(wrong).as_ref(), &cert).is_err());
        // No pin → same webpki rejection (unpinned self-signed is never trusted).
        let none = Arc::new(Mutex::new(None));
        assert!(verify(PinnedVerifier::new(none).as_ref(), &cert).is_err());
    }

    #[test]
    fn capture_records_fingerprint_and_untrusted() {
        let cert = CertificateDer::from(b"not-a-real-cert".to_vec());
        let captured = Arc::new(Mutex::new(None));
        let v = CaptureVerifier::new(captured.clone());
        assert!(verify(v.as_ref(), &cert).is_ok()); // probe accepts anything
        let (fp, trusted) = captured.lock().unwrap().clone().unwrap();
        assert_eq!(fp, cert_fingerprint(&cert));
        assert!(!trusted); // a garbage/self-signed cert is not webpki-trusted
    }
}
