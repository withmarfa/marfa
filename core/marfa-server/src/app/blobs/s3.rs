//! The object store: one object per write of a blob, under `<prefix>/<hex>/<write>`, and a
//! marker object that holds the store's id.

use std::io;
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::client::{HttpError, HttpErrorKind};
use object_store::path::Path;
use object_store::signer::Signer;
use object_store::{
    Attribute, Attributes, BackoffConfig, ClientOptions, GetOptions, GetRange, ObjectStore,
    ObjectStoreExt, PutMultipartOptions, PutOptions, PutPayload, RetryConfig, WriteMultipart,
};
use uuid::Uuid;

use super::hash::Hash;
use super::store::Answer;
use crate::settings::start::ObjectStoreSettings;

/// The most bytes sent in one request; a larger blob goes up in parts of this size.
const PART: usize = 8 * 1024 * 1024;
const PARTS_IN_FLIGHT: usize = 2;
const MARKER: &str = ".marfa-store";
/// The object metadata that names the store which wrote an object.
const WRITER: &str = "marfa-store";

#[derive(Debug)]
pub struct S3 {
    id: String,
    locator: String,
    prefix: String,
    client: AmazonS3,
}

fn failed(error: object_store::Error) -> io::Error {
    io::Error::from(error)
}

fn is_missing(error: &object_store::Error) -> bool {
    matches!(error, object_store::Error::NotFound { .. })
}

/// Whether the store was never reached or did not answer in time, as against answering.
fn is_silent(error: &object_store::Error) -> bool {
    let mut cause = std::error::Error::source(error);
    while let Some(error) = cause {
        if let Some(http) = error.downcast_ref::<HttpError>() {
            return matches!(http.kind(), HttpErrorKind::Connect | HttpErrorKind::Timeout);
        }
        cause = error.source();
    }
    false
}

/// What a store answered when asked for its marker.
#[derive(Debug)]
pub enum Marker {
    Id(String),
    None,
    /// No connection, or no answer in time.
    Silent(io::Error),
    /// An answer that names no store: a refusal, an error or a marker that does not read.
    Refused(io::Error),
}

/// The bytes of one blob as an object store takes them back, naming the store that wrote them.
fn attributes(mime_type: &str, hash: &Hash, store_id: &str) -> Attributes {
    let mut attributes = Attributes::new();
    attributes.insert(
        Attribute::Metadata(WRITER.into()),
        store_id.to_string().into(),
    );
    attributes.insert(Attribute::ContentType, mime_type.to_string().into());
    attributes.insert(
        Attribute::ContentDisposition,
        format!("attachment; filename=\"{}\"", hash.hex()).into(),
    );
    attributes
}

impl S3 {
    fn client(settings: &ObjectStoreSettings) -> io::Result<AmazonS3> {
        let retry = RetryConfig {
            backoff: BackoffConfig::default(),
            max_retries: 2,
            retry_timeout: Duration::from_secs(10),
        };
        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(&settings.bucket)
            .with_region(&settings.region)
            .with_retry(retry)
            // Every call is bounded where it is made, credentials included, so a large transfer
            // can outlast any one request timeout.
            .with_client_options(
                ClientOptions::new()
                    .with_timeout_disabled()
                    .with_connect_timeout(Duration::from_secs(5)),
            );
        if let Some(endpoint) = &settings.endpoint {
            builder = builder
                .with_endpoint(endpoint)
                .with_allow_http(endpoint.starts_with("http://"))
                .with_virtual_hosted_style_request(!settings.path_style);
        }
        if let Some(key) = &settings.access_key_id {
            builder = builder.with_access_key_id(key);
        }
        if let Some(secret) = &settings.secret_access_key {
            builder = builder.with_secret_access_key(secret);
        }
        builder.build().map_err(failed)
    }

    /// The configured store, before its marker says which store it is.
    pub fn new(settings: &ObjectStoreSettings, id: String) -> io::Result<S3> {
        Ok(S3 {
            id,
            locator: settings.locator(),
            prefix: settings.prefix.clone(),
            client: S3::client(settings)?,
        })
    }

    fn marker_path(&self) -> Path {
        Path::from(format!("{}/{MARKER}", self.prefix))
    }

    /// The store id the marker object holds.
    pub async fn marker(&self) -> Marker {
        let found = match self.client.get(&self.marker_path()).await {
            Ok(found) => found.bytes().await,
            Err(error) => Err(error),
        };
        match found {
            Ok(text) => match Uuid::parse_str(String::from_utf8_lossy(&text).trim()) {
                Ok(id) => Marker::Id(id.to_string()),
                Err(_) => Marker::Refused(io::Error::other(
                    "the store's marker does not hold a store id",
                )),
            },
            Err(error) if is_missing(&error) => Marker::None,
            Err(error) if is_silent(&error) => Marker::Silent(failed(error)),
            Err(error) => Marker::Refused(failed(error)),
        }
    }

    /// Writes this store's id as the marker object.
    pub async fn mark(&self) -> io::Result<()> {
        self.client
            .put(
                &self.marker_path(),
                PutPayload::from(self.id.clone().into_bytes()),
            )
            .await
            .map(|_| ())
            .map_err(failed)
    }

    /// A missing marker distinguishes an unavailable bucket from a missing copy.
    pub async fn is_itself(&self) -> io::Result<()> {
        match self.marker().await {
            Marker::Id(id) if id == self.id => Ok(()),
            Marker::Id(_) => Err(io::Error::other("the store's marker names another store")),
            Marker::None => Err(io::Error::other("the store holds no marker")),
            Marker::Silent(error) | Marker::Refused(error) => Err(error),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn locator(&self) -> &str {
        &self.locator
    }

    fn path_of(&self, key: &str) -> Path {
        Path::from(format!("{}/{key}", self.prefix))
    }

    /// The name, under the prefix, of a new object for the blob's bytes. No two writes share one,
    /// so a request that lands late can only touch the object it names.
    pub fn new_key(hash: &Hash) -> String {
        format!("{}/{}", hash.hex(), Uuid::now_v7().simple())
    }

    pub async fn size_of(&self, key: &str) -> io::Result<Option<u64>> {
        match self.client.head(&self.path_of(key)).await {
            Ok(meta) => Ok(Some(meta.size)),
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    /// What the store answers for the object at `key`, and whether the object names this store.
    pub async fn answer_for(&self, key: &str) -> io::Result<Answer> {
        let options = GetOptions {
            head: true,
            ..GetOptions::default()
        };
        match self.client.get_opts(&self.path_of(key), options).await {
            Ok(found) => {
                let writer = found.attributes.get(&Attribute::Metadata(WRITER.into()));
                if writer.is_some_and(|writer| writer.as_ref() == self.id) {
                    Ok(Answer::Holds(found.meta.size))
                } else {
                    Ok(Answer::Foreign(found.meta.size))
                }
            }
            Err(error) if is_missing(&error) => Ok(Answer::Missing),
            Err(error) => Err(failed(error)),
        }
    }

    /// Every object the store holds for the blob, by name under the prefix, with its size.
    pub async fn objects_of(&self, hash: &Hash) -> io::Result<Vec<(String, u64)>> {
        let root = Path::from(self.prefix.as_str());
        let under = Path::from(format!("{}/{}", self.prefix, hash.hex()));
        self.client
            .list(Some(&under))
            .map_ok(move |meta| {
                let name = meta
                    .location
                    .prefix_match(&root)
                    .map(|parts| parts.map(|part| part.as_ref().to_string()))
                    .map(|parts| parts.collect::<Vec<_>>().join("/"))
                    .unwrap_or_default();
                (name, meta.size)
            })
            .try_collect()
            .await
            .map_err(failed)
    }

    pub async fn read(
        &self,
        key: &str,
        first: u64,
        length: u64,
    ) -> io::Result<BoxStream<'static, io::Result<Bytes>>> {
        let options = GetOptions {
            range: Some(GetRange::Bounded(first..first + length)),
            ..GetOptions::default()
        };
        let found = self
            .client
            .get_opts(&self.path_of(key), options)
            .await
            .map_err(failed)?;
        Ok(found.into_stream().map_err(failed).boxed())
    }

    /// Sends the bytes and keeps them only if they hash to `hash`; a short body is sent
    /// whole, so nothing is placed before it is checked.
    pub async fn write(
        &self,
        key: &str,
        hash: &Hash,
        mime_type: &str,
        size: u64,
        mut bytes: BoxStream<'static, io::Result<Bytes>>,
    ) -> io::Result<()> {
        let mut hasher = super::store::Hasher::default();
        let location = self.path_of(key);
        if size <= PART as u64 {
            let mut whole = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk?;
                hasher.update(&chunk);
                whole.extend_from_slice(&chunk);
            }
            hasher.matches(hash, size)?;
            let options = PutOptions {
                attributes: attributes(mime_type, hash, &self.id),
                ..PutOptions::default()
            };
            self.client
                .put_opts(&location, PutPayload::from(whole), options)
                .await
                .map_err(failed)?;
            return Ok(());
        }
        let options = PutMultipartOptions {
            attributes: attributes(mime_type, hash, &self.id),
            ..PutMultipartOptions::default()
        };
        let upload = self
            .client
            .put_multipart_opts(&location, options)
            .await
            .map_err(failed)?;
        let mut parts = WriteMultipart::new_with_chunk_size(upload, PART);
        let sent = async {
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk?;
                hasher.update(&chunk);
                parts
                    .wait_for_capacity(PARTS_IN_FLIGHT)
                    .await
                    .map_err(failed)?;
                parts.put(chunk);
            }
            hasher.matches(hash, size)
        }
        .await;
        match sent {
            Ok(()) => parts.finish().await.map(|_| ()).map_err(failed),
            Err(error) => {
                let _ = parts.abort().await;
                Err(error)
            }
        }
    }

    /// Puts `bytes` as the object at `key`, which appears whole or not at all: one put for a
    /// body of up to a part, and above that a multipart upload, which no listing or read sees
    /// before it completes and which is aborted on failure. Answers the bytes put.
    pub async fn put_whole(
        &self,
        key: &str,
        content_type: &str,
        mut bytes: BoxStream<'static, io::Result<Bytes>>,
    ) -> io::Result<u64> {
        let location = self.path_of(key);
        let mut attributes = Attributes::new();
        attributes.insert(Attribute::ContentType, content_type.to_string().into());
        attributes.insert(Attribute::Metadata(WRITER.into()), self.id.clone().into());
        let mut first: Vec<Bytes> = Vec::new();
        let mut held = 0usize;
        let mut ended = false;
        while held <= PART {
            match bytes.next().await {
                Some(chunk) => {
                    let chunk = chunk?;
                    held += chunk.len();
                    first.push(chunk);
                }
                None => {
                    ended = true;
                    break;
                }
            }
        }
        if ended {
            let options = PutOptions {
                attributes,
                ..PutOptions::default()
            };
            self.client
                .put_opts(&location, PutPayload::from_iter(first), options)
                .await
                .map_err(failed)?;
            return Ok(held as u64);
        }
        let options = PutMultipartOptions {
            attributes,
            ..PutMultipartOptions::default()
        };
        let upload = self
            .client
            .put_multipart_opts(&location, options)
            .await
            .map_err(failed)?;
        let mut parts = WriteMultipart::new_with_chunk_size(upload, PART);
        let mut total = 0u64;
        let sent = async {
            let mut pending = futures_util::stream::iter(first.into_iter().map(Ok)).chain(bytes);
            while let Some(chunk) = pending.next().await {
                let chunk = chunk?;
                total += chunk.len() as u64;
                parts
                    .wait_for_capacity(PARTS_IN_FLIGHT)
                    .await
                    .map_err(failed)?;
                parts.put(chunk);
            }
            Ok::<(), io::Error>(())
        }
        .await;
        match sent {
            Ok(()) => parts.finish().await.map(|_| total).map_err(failed),
            Err(error) => {
                let _ = parts.abort().await;
                Err(error)
            }
        }
    }

    /// The objects directly under `folder`, by name within it, with their sizes.
    pub async fn list_in(&self, folder: &str) -> io::Result<Vec<(String, u64)>> {
        let under = self.path_of(folder);
        let listed = self
            .client
            .list_with_delimiter(Some(&under))
            .await
            .map_err(failed)?;
        Ok(listed
            .objects
            .into_iter()
            .filter_map(|meta| {
                let mut parts = meta.location.prefix_match(&under)?;
                let name = parts.next()?.as_ref().to_string();
                parts.next().is_none().then_some((name, meta.size))
            })
            .collect())
    }

    /// The whole object at `key` and its size, or `None` where the store holds none.
    pub async fn get_whole(
        &self,
        key: &str,
    ) -> io::Result<Option<(u64, BoxStream<'static, io::Result<Bytes>>)>> {
        match self.client.get(&self.path_of(key)).await {
            Ok(found) => {
                let size = found.meta.size;
                Ok(Some((size, found.into_stream().map_err(failed).boxed())))
            }
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    pub async fn delete(&self, key: &str) -> io::Result<()> {
        match self.client.delete(&self.path_of(key)).await {
            Ok(()) => Ok(()),
            Err(error) if is_missing(&error) => Ok(()),
            Err(error) => Err(failed(error)),
        }
    }

    /// A link the store serves itself, signed with the store's own clock, made within `limit`
    /// with the wait for credentials included.
    pub async fn link(&self, key: &str, ttl: Duration, limit: Duration) -> io::Result<String> {
        let path = self.path_of(key);
        let signed = self.client.signed_url(axum::http::Method::GET, &path, ttl);
        match tokio::time::timeout(limit, signed).await {
            Ok(signed) => signed.map(|url| url.to_string()).map_err(failed),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "the object store's credentials did not arrive in time",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::Arc;

    use object_store::CredentialProvider;
    use object_store::aws::AwsCredential;

    use super::*;

    /// Credentials that never arrive, as from an instance metadata endpoint that stopped
    /// answering.
    #[derive(Debug)]
    struct Unanswered;

    impl CredentialProvider for Unanswered {
        type Credential = AwsCredential;

        fn get_credential<'a, 'b>(
            &'a self,
        ) -> Pin<Box<dyn Future<Output = object_store::Result<Arc<AwsCredential>>> + Send + 'b>>
        where
            'a: 'b,
            Self: 'b,
        {
            Box::pin(std::future::pending())
        }
    }

    #[tokio::test]
    async fn a_link_waiting_on_credentials_fails_within_its_limit() {
        let client = AmazonS3Builder::new()
            .with_bucket_name("marfa")
            .with_region("us-east-1")
            .with_credentials(Arc::new(Unanswered))
            .build()
            .unwrap();
        let s3 = S3 {
            id: Uuid::now_v7().to_string(),
            locator: "s3://marfa/blobs".to_string(),
            prefix: "blobs".to_string(),
            client,
        };
        let limit = Duration::from_millis(50);
        let link = s3.link("a/b", Duration::from_secs(60), limit);
        let answer = tokio::time::timeout(limit * 40, link).await;
        assert!(
            matches!(&answer, Ok(Err(error)) if error.kind() == io::ErrorKind::TimedOut),
            "{answer:?}"
        );
    }
}
