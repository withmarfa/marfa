//! The object store: one object per write of a blob, under `<prefix>/blobs/<hex>/<write>`, a
//! marker object at `<prefix>/blobs/.marfa-store` that holds the store's id, and whole objects
//! such as backups elsewhere under `<prefix>`.

use std::future::Future;
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
    Attribute, Attributes, BackoffConfig, ClientOptions, GetOptions, GetRange, MultipartUpload,
    ObjectStore, ObjectStoreExt, PutMultipartOptions, PutOptions, PutPayload, RetryConfig,
};
use tokio::task::JoinSet;
use tokio::time::Instant;
use uuid::Uuid;

use super::hash::Hash;
use super::store::Answer;
use crate::settings::start::ObjectStoreSettings;

/// The most bytes sent in one request; a larger blob goes up in parts of this size.
const PART: usize = 8 * 1024 * 1024;
const PARTS_IN_FLIGHT: usize = 2;
const ABORT_DEADLINE: Duration = Duration::from_secs(15);
const MARKER: &str = ".marfa-store";
/// The folder under the prefix that holds the blobs' objects and the marker.
const BLOBS: &str = "blobs";
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

type Checked<'a> = Option<(&'a mut super::store::Hasher, &'a Hash, u64)>;

fn seen(checked: &mut Checked<'_>, chunk: &Bytes) {
    if let Some((hasher, _, _)) = checked {
        hasher.update(chunk);
    }
}

fn verify(checked: &Checked<'_>) -> io::Result<()> {
    match checked {
        Some((hasher, hash, size)) => hasher.matches(hash, *size),
        None => Ok(()),
    }
}

fn stalled() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "the object store stalled")
}

async fn within_deadline<T>(
    deadline: Instant,
    work: impl Future<Output = io::Result<T>>,
) -> io::Result<T> {
    tokio::time::timeout_at(deadline, work)
        .await
        .unwrap_or_else(|_| Err(stalled()))
}

/// Aborts an unfinished multipart upload, within a bound of its own, so its parts are not left
/// in the bucket.
async fn abort(upload: &mut dyn MultipartUpload) {
    match tokio::time::timeout(ABORT_DEADLINE, upload.abort()).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(%error, "An unfinished upload was not aborted"),
        Err(_) => tracing::warn!("An unfinished upload's abort did not end in time"),
    }
}

/// A multipart upload's parts: each `PART` bytes but the last, at most `PARTS_IN_FLIGHT` sent
/// at once. The upload stays with the caller, so it can still be aborted.
#[derive(Default)]
struct Parts {
    buffer: Vec<Bytes>,
    buffered: usize,
    tasks: JoinSet<object_store::Result<()>>,
}

impl Parts {
    async fn put(&mut self, upload: &mut dyn MultipartUpload, mut bytes: Bytes) -> io::Result<()> {
        while !bytes.is_empty() {
            let room = PART - self.buffered;
            if bytes.len() < room {
                self.buffered += bytes.len();
                self.buffer.push(bytes);
                return Ok(());
            }
            self.buffer.push(bytes.split_to(room));
            self.send(upload, PARTS_IN_FLIGHT).await?;
        }
        Ok(())
    }

    async fn send(&mut self, upload: &mut dyn MultipartUpload, in_flight: usize) -> io::Result<()> {
        while self.tasks.len() >= in_flight {
            self.next().await?;
        }
        let part = PutPayload::from_iter(std::mem::take(&mut self.buffer));
        self.buffered = 0;
        self.tasks.spawn(upload.put_part(part));
        Ok(())
    }

    async fn next(&mut self) -> io::Result<()> {
        match self.tasks.join_next().await {
            Some(Ok(sent)) => sent.map_err(failed),
            Some(Err(_)) => Err(io::Error::other("a part's upload ended early")),
            None => Ok(()),
        }
    }

    async fn finish(&mut self, upload: &mut dyn MultipartUpload) -> io::Result<()> {
        if !self.buffer.is_empty() {
            self.send(upload, PARTS_IN_FLIGHT).await?;
        }
        while !self.tasks.is_empty() {
            self.next().await?;
        }
        Ok(())
    }
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
        self.blob_path(MARKER)
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

    /// A blob's object, named as the copy record names it.
    fn blob_path(&self, object: &str) -> Path {
        Path::from(format!("{}/{BLOBS}/{object}", self.prefix))
    }

    /// A whole object, named by its key under the prefix.
    fn path_of(&self, key: &str) -> Path {
        Path::from(format!("{}/{key}", self.prefix))
    }

    /// The name, under the blobs' folder, of a new object for the blob's bytes. No two writes share one,
    /// so a request that lands late can only touch the object it names.
    pub fn new_key(hash: &Hash) -> String {
        format!("{}/{}", hash.hex(), Uuid::now_v7().simple())
    }

    pub async fn size_of(&self, object: &str) -> io::Result<Option<u64>> {
        match self.client.head(&self.blob_path(object)).await {
            Ok(meta) => Ok(Some(meta.size)),
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    /// What the store answers for a blob's object, and whether the object names this store.
    pub async fn answer_for(&self, object: &str) -> io::Result<Answer> {
        let options = GetOptions {
            head: true,
            ..GetOptions::default()
        };
        match self.client.get_opts(&self.blob_path(object), options).await {
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

    /// Every object the store holds for the blob, by name under the blobs' folder, with its size.
    pub async fn objects_of(&self, hash: &Hash) -> io::Result<Vec<(String, u64)>> {
        let root = Path::from(format!("{}/{BLOBS}", self.prefix));
        let under = self.blob_path(hash.hex());
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
        object: &str,
        first: u64,
        length: u64,
    ) -> io::Result<BoxStream<'static, io::Result<Bytes>>> {
        let options = GetOptions {
            range: Some(GetRange::Bounded(first..first + length)),
            ..GetOptions::default()
        };
        let found = self
            .client
            .get_opts(&self.blob_path(object), options)
            .await
            .map_err(failed)?;
        Ok(found.into_stream().map_err(failed).boxed())
    }

    /// Sends the bytes and keeps them only if they hash to `hash`; a short body is sent
    /// whole, so nothing is placed before it is checked. Fails once it outlasts `limit`.
    pub async fn write(
        &self,
        object: &str,
        hash: &Hash,
        mime_type: &str,
        size: u64,
        bytes: BoxStream<'static, io::Result<Bytes>>,
        limit: Duration,
    ) -> io::Result<()> {
        let deadline = Instant::now() + limit;
        let mut hasher = super::store::Hasher::default();
        let attributes = attributes(mime_type, hash, &self.id);
        let checked = Some((&mut hasher, hash, size));
        self.place(self.blob_path(object), attributes, bytes, deadline, checked)
            .await
            .map(|_| ())
    }

    /// Appears whole or not at all; fails once it outlasts `limit`.
    pub async fn put_whole(
        &self,
        key: &str,
        content_type: &str,
        bytes: BoxStream<'static, io::Result<Bytes>>,
        limit: Duration,
    ) -> io::Result<u64> {
        let deadline = Instant::now() + limit;
        let mut attributes = Attributes::new();
        attributes.insert(Attribute::ContentType, content_type.to_string().into());
        attributes.insert(Attribute::Metadata(WRITER.into()), self.id.clone().into());
        self.place(self.path_of(key), attributes, bytes, deadline, None)
            .await
    }

    /// A body above one part goes multipart, aborted on failure or at `deadline`.
    async fn place(
        &self,
        location: Path,
        attributes: Attributes,
        mut bytes: BoxStream<'static, io::Result<Bytes>>,
        deadline: Instant,
        mut checked: Checked<'_>,
    ) -> io::Result<u64> {
        let mut first: Vec<Bytes> = Vec::new();
        let mut held = 0u64;
        let mut ended = false;
        within_deadline(deadline, async {
            while held <= PART as u64 {
                match bytes.next().await {
                    Some(chunk) => {
                        let chunk = chunk?;
                        held += chunk.len() as u64;
                        seen(&mut checked, &chunk);
                        first.push(chunk);
                    }
                    None => {
                        ended = true;
                        break;
                    }
                }
            }
            Ok(())
        })
        .await?;
        if ended {
            verify(&checked)?;
            let options = PutOptions {
                attributes,
                ..PutOptions::default()
            };
            let put = self
                .client
                .put_opts(&location, PutPayload::from_iter(first), options);
            within_deadline(deadline, async { put.await.map_err(failed) }).await?;
            return Ok(held);
        }
        let options = PutMultipartOptions {
            attributes,
            ..PutMultipartOptions::default()
        };
        let begun = self.client.put_multipart_opts(&location, options);
        let mut upload = within_deadline(deadline, async { begun.await.map_err(failed) }).await?;
        let mut parts = Parts::default();
        let sent = within_deadline(deadline, async {
            for chunk in first {
                parts.put(upload.as_mut(), chunk).await?;
            }
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk?;
                held += chunk.len() as u64;
                seen(&mut checked, &chunk);
                parts.put(upload.as_mut(), chunk).await?;
            }
            verify(&checked)?;
            parts.finish(upload.as_mut()).await?;
            upload.complete().await.map_err(failed)
        })
        .await;
        match sent {
            Ok(_) => Ok(held),
            Err(error) => {
                parts.tasks.shutdown().await;
                abort(upload.as_mut()).await;
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

    /// Every object at any depth under `folder`, by the path segments within it, with its size.
    pub async fn list_under(&self, folder: &str) -> io::Result<Vec<(Vec<String>, u64)>> {
        let under = self.path_of(folder);
        self.client
            .list(Some(&under))
            .map_ok(|meta| {
                let parts = meta
                    .location
                    .prefix_match(&under)
                    .map(|parts| parts.map(|part| part.as_ref().to_string()).collect())
                    .unwrap_or_default();
                (parts, meta.size)
            })
            .try_collect()
            .await
            .map_err(failed)
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

    /// Deletes a blob's object.
    pub async fn delete(&self, object: &str) -> io::Result<()> {
        self.remove(&self.blob_path(object)).await
    }

    /// Deletes the whole object at `key`.
    pub async fn delete_whole(&self, key: &str) -> io::Result<()> {
        self.remove(&self.path_of(key)).await
    }

    async fn remove(&self, location: &Path) -> io::Result<()> {
        match self.client.delete(location).await {
            Ok(()) => Ok(()),
            Err(error) if is_missing(&error) => Ok(()),
            Err(error) => Err(failed(error)),
        }
    }

    /// A link the store serves itself, signed with the store's own clock, made within `limit`
    /// with the wait for credentials included.
    pub async fn link(&self, object: &str, ttl: Duration, limit: Duration) -> io::Result<String> {
        let path = self.blob_path(object);
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
            locator: "s3://marfa/marfa".to_string(),
            prefix: "marfa".to_string(),
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
