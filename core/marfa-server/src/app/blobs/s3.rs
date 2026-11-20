//! The object store: one object per write of a blob, under `<prefix>/blobs/<hex>/<write>`, a
//! marker object at `<prefix>/blobs/.marfa-store` that holds the store's id, and whole objects
//! such as backups elsewhere under `<prefix>`.

use std::future::Future;
use std::io;
use std::sync::Arc;
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
use crate::app::faults::Faults;
use crate::app::outbound::store::{Guarded, METADATA_ENDPOINT, PublicOnly, Refused};
use crate::settings::Snapshot;
use crate::settings::registry::{
    ALLOW_PRIVATE_ADDRESSES, OBJECT_STORE_ACCESS_KEY_ID, OBJECT_STORE_BUCKET,
    OBJECT_STORE_ENDPOINT, OBJECT_STORE_PATH_STYLE, OBJECT_STORE_PREFIX, OBJECT_STORE_REGION,
    OBJECT_STORE_SECRET_ACCESS_KEY,
};
use crate::settings::sealed::Secret;

/// The object store the settings name; its endpoint and secret are never logged.
#[derive(Clone, PartialEq, Eq)]
pub struct ObjectStoreSettings {
    pub bucket: String,
    pub region: String,
    pub endpoint: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<Secret>,
    pub path_style: bool,
    pub prefix: String,
    pub private_allowed: bool,
}

impl std::fmt::Debug for ObjectStoreSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.locator())
    }
}

impl ObjectStoreSettings {
    pub fn locator(&self) -> String {
        format!("s3://{}/{}", self.bucket, self.prefix)
    }

    /// Why the store cannot be reached by virtual host, where it is addressed so.
    pub fn unaddressable(&self) -> Option<Unaddressable> {
        match (&self.endpoint, self.path_style) {
            (Some(endpoint), false) => virtual_host(&self.bucket, endpoint).err(),
            _ => None,
        }
    }

    /// The store `settings` name, where they name a bucket. Where a bucket is named or its row
    /// does not read, the answer is every store setting that does not read, and no store is taken.
    pub fn of(settings: &Snapshot) -> Result<Option<ObjectStoreSettings>, Vec<&'static str>> {
        let unreadable = settings.unreadable();
        let bucket = settings.get(OBJECT_STORE_BUCKET);
        if bucket.is_some() || unreadable.contains(&OBJECT_STORE_BUCKET.entry.key) {
            let keys: Vec<&'static str> = [
                OBJECT_STORE_BUCKET.entry.key,
                OBJECT_STORE_REGION.entry.key,
                OBJECT_STORE_ENDPOINT.entry.key,
                OBJECT_STORE_PATH_STYLE.entry.key,
                OBJECT_STORE_PREFIX.entry.key,
                OBJECT_STORE_ACCESS_KEY_ID.entry.key,
                OBJECT_STORE_SECRET_ACCESS_KEY.entry.key,
            ]
            .into_iter()
            .filter(|key| unreadable.contains(key))
            .collect();
            if !keys.is_empty() {
                return Err(keys);
            }
        }
        let Some(bucket) = bucket else {
            return Ok(None);
        };
        let endpoint = settings.get(OBJECT_STORE_ENDPOINT);
        Ok(Some(ObjectStoreSettings {
            bucket,
            region: settings
                .get(OBJECT_STORE_REGION)
                .unwrap_or_else(|| "us-east-1".to_string()),
            path_style: endpoint.is_none() || settings.get(OBJECT_STORE_PATH_STYLE),
            endpoint,
            access_key_id: settings.get(OBJECT_STORE_ACCESS_KEY_ID),
            secret_access_key: settings.get(OBJECT_STORE_SECRET_ACCESS_KEY),
            prefix: settings
                .get(OBJECT_STORE_PREFIX)
                .unwrap_or_else(|| "marfa".to_string()),
            private_allowed: settings.get(ALLOW_PRIVATE_ADDRESSES),
        }))
    }
}

/// The most bytes sent in one request; a larger blob goes up in parts of this size.
const PART: usize = 8 * 1024 * 1024;
const PARTS_IN_FLIGHT: usize = 2;
const ABORT_DEADLINE: Duration = Duration::from_secs(15);
const MARKER: &str = ".marfa-store";
/// The folder under the prefix that holds the blobs' objects and the marker.
pub const BLOBS: &str = "blobs";
/// The object metadata that names the store which wrote an object.
const WRITER: &str = "marfa-store";

#[derive(Debug)]
pub struct S3 {
    id: String,
    locator: String,
    prefix: String,
    client: AmazonS3,
    guarded: Arc<Guarded>,
}

/// An ETag as a listing and an upload's answer both give it, without the quotes some stores add.
fn etag(raw: &str) -> String {
    raw.trim_start_matches("W/").trim_matches('"').to_string()
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

/// Why the settings cannot put the bucket before the store's host.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unaddressable {
    /// The bucket is not lowercase labels of a host name.
    Bucket,
    /// The endpoint's host is an IP address.
    Address,
    /// The endpoint's host has an empty label or one longer than a label may be.
    Host,
    /// The bucket and the endpoint's host are longer together than a host name may be.
    Long,
}

impl Unaddressable {
    /// The setting at fault.
    pub fn key(self) -> &'static str {
        match self {
            Unaddressable::Bucket => OBJECT_STORE_BUCKET.entry.key,
            Unaddressable::Address | Unaddressable::Host | Unaddressable::Long => {
                OBJECT_STORE_ENDPOINT.entry.key
            }
        }
    }

    /// Why, naming the settings and none of their values.
    pub fn reason(self) -> &'static str {
        match self {
            Unaddressable::Bucket => {
                "object_store_path_style is false, so the bucket goes before the host of \
                 object_store_endpoint, and object_store_bucket must then be labels of 1 to 63 \
                 lowercase letters, digits and hyphens, joined by dots, none starting or ending \
                 with a hyphen; set object_store_path_style to true to keep this bucket"
            }
            Unaddressable::Address => {
                "object_store_path_style is false, so the bucket goes before the host of \
                 object_store_endpoint, which must then be a name, not an IP address; set \
                 object_store_path_style to true to reach the store at an address"
            }
            Unaddressable::Host => {
                "object_store_path_style is false, so the bucket goes before the host of \
                 object_store_endpoint, which must then be labels of 1 to 63 characters joined \
                 by dots, with at most one dot at its end"
            }
            Unaddressable::Long => {
                "object_store_path_style is false, so the bucket goes before the host of \
                 object_store_endpoint, and the two together, without a dot at the end, are \
                 longer than the 253 characters a host name may be"
            }
        }
    }
}

const LABEL_LONGEST: usize = 63;
const HOST_LONGEST: usize = 253;

fn is_label(label: &str) -> bool {
    (1..=LABEL_LONGEST).contains(&label.len())
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && !label.starts_with('-')
        && !label.ends_with('-')
}

/// The endpoint with the bucket before its host. Given a custom endpoint and virtual-host
/// requests, the client takes the endpoint as one that already names the bucket.
pub fn virtual_host(bucket: &str, endpoint: &str) -> Result<String, Unaddressable> {
    if !bucket.split('.').all(is_label) {
        return Err(Unaddressable::Bucket);
    }
    let mut url = url::Url::parse(endpoint).map_err(|_| Unaddressable::Address)?;
    let Some(url::Host::Domain(host)) = url.host() else {
        return Err(Unaddressable::Address);
    };
    let named = format!("{bucket}.{host}");
    // One dot at the end names the root, which a resolver does not count.
    let counted = named.strip_suffix('.').unwrap_or(&named);
    if !counted
        .split('.')
        .all(|label| (1..=LABEL_LONGEST).contains(&label.len()))
    {
        return Err(Unaddressable::Host);
    }
    if counted.len() > HOST_LONGEST {
        return Err(Unaddressable::Long);
    }
    url.set_host(Some(&named))
        .map_err(|_| Unaddressable::Bucket)?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

impl S3 {
    fn builder(
        settings: &ObjectStoreSettings,
        faults: &Arc<Faults>,
        guarded: &Arc<Guarded>,
    ) -> io::Result<AmazonS3Builder> {
        let retry = RetryConfig {
            backoff: BackoffConfig::default(),
            max_retries: 2,
            retry_timeout: Duration::from_secs(10),
        };
        let connect_timeout = Duration::from_secs(5);
        let mut builder = AmazonS3Builder::new()
            // The client signs the path as written, and SigV4 signs a colon escaped.
            .with_bucket_name(settings.bucket.replace(':', "%3A"))
            .with_region(&settings.region)
            .with_retry(retry)
            .with_metadata_endpoint(METADATA_ENDPOINT)
            // Every call is bounded where it is made, credentials included, so a large transfer
            // can outlast any one request timeout.
            .with_client_options(
                ClientOptions::new()
                    .with_timeout_disabled()
                    .with_connect_timeout(connect_timeout),
            );
        if !settings.private_allowed {
            builder = builder.with_http_connector(PublicOnly {
                connect_timeout,
                faults: faults.clone(),
                guarded: guarded.clone(),
            });
        }
        if let Some(endpoint) = &settings.endpoint {
            builder = builder
                .with_endpoint(if settings.path_style {
                    endpoint.clone()
                } else {
                    virtual_host(&settings.bucket, endpoint)
                        .map_err(|why| io::Error::other(why.reason()))?
                })
                .with_allow_http(endpoint.starts_with("http://"))
                .with_virtual_hosted_style_request(!settings.path_style);
        }
        if let Some(key) = &settings.access_key_id {
            builder = builder.with_access_key_id(key);
        }
        if let Some(secret) = &settings.secret_access_key {
            builder = builder.with_secret_access_key(secret.expose());
        }
        Ok(builder)
    }

    /// The configured store, before its marker says which store it is.
    pub fn new(settings: &ObjectStoreSettings, id: String, faults: &Arc<Faults>) -> io::Result<S3> {
        let guarded = Arc::<Guarded>::default();
        Ok(S3 {
            id,
            locator: settings.locator(),
            prefix: settings.prefix.clone(),
            client: S3::builder(settings, faults, &guarded)?
                .build()
                .map_err(failed)?,
            guarded,
        })
    }

    /// The same store and client under the id its marker gave, so what the client met carries over.
    pub fn named(self, id: String) -> S3 {
        S3 { id, ..self }
    }

    /// The kind of request the address rules refused the last time it was made.
    pub fn refused(&self) -> Option<Refused> {
        self.guarded.refused()
    }

    /// Why the store cannot be used while the address rules refuse it, in the owner's words.
    pub fn refusal(&self) -> Option<String> {
        self.refused().map(|refused| {
            format!(
                "The object store cannot be used: {}. Until it can, no file is copied there, no \
                 backup is taken and no file is purged.",
                refused.reason()
            )
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

    /// Appears whole or not at all; fails once it outlasts `limit`. Answers the size and the
    /// ETag the store gave the object, when it gave one.
    pub async fn put_whole(
        &self,
        key: &str,
        content_type: &str,
        bytes: BoxStream<'static, io::Result<Bytes>>,
        limit: Duration,
    ) -> io::Result<(u64, Option<String>)> {
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
    ) -> io::Result<(u64, Option<String>)> {
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
            let put = within_deadline(deadline, async { put.await.map_err(failed) }).await?;
            return Ok((held, put.e_tag.as_deref().map(etag)));
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
            Ok(put) => Ok((held, put.e_tag.as_deref().map(etag))),
            Err(error) => {
                parts.tasks.shutdown().await;
                abort(upload.as_mut()).await;
                Err(error)
            }
        }
    }

    /// The objects directly under `folder`, by name within it, with their sizes and ETags.
    pub async fn list_in(&self, folder: &str) -> io::Result<Vec<(String, u64, Option<String>)>> {
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
                let tag = meta.e_tag.as_deref().map(etag);
                parts.next().is_none().then_some((name, meta.size, tag))
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

    /// The whole object at `key`, its size and the ETag of the bytes it answers, or `None` where
    /// the store holds none.
    pub async fn get_whole(
        &self,
        key: &str,
    ) -> io::Result<Option<(u64, Option<String>, BoxStream<'static, io::Result<Bytes>>)>> {
        match self.client.get(&self.path_of(key)).await {
            Ok(found) => {
                let size = found.meta.size;
                let tag = found.meta.e_tag.as_deref().map(etag);
                Ok(Some((
                    size,
                    tag,
                    found.into_stream().map_err(failed).boxed(),
                )))
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
        let signed = self.client.signed_url(http::Method::GET, &path, ttl);
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
    use std::sync::Mutex;

    use async_trait::async_trait;
    use object_store::CredentialProvider;
    use object_store::aws::AwsCredential;
    use object_store::client::{
        HttpClient, HttpConnector, HttpRequest, HttpResponse, HttpResponseBody, HttpService,
    };

    use super::*;

    /// Answers every request `404`, as a store with no marker does, and keeps the address each
    /// was sent to.
    #[derive(Clone, Debug, Default)]
    struct Recorded(Arc<Mutex<Vec<String>>>);

    impl HttpConnector for Recorded {
        fn connect(&self, _options: &ClientOptions) -> object_store::Result<HttpClient> {
            Ok(HttpClient::new(self.clone()))
        }
    }

    #[async_trait]
    impl HttpService for Recorded {
        async fn call(&self, request: HttpRequest) -> Result<HttpResponse, HttpError> {
            self.0.lock().unwrap().push(request.uri().to_string());
            Ok(http::Response::builder()
                .status(http::StatusCode::NOT_FOUND)
                .body(HttpResponseBody::from(String::new()))
                .unwrap())
        }
    }

    fn settings(endpoint: &str, path_style: bool) -> ObjectStoreSettings {
        ObjectStoreSettings {
            bucket: "marfa".to_string(),
            region: "us-east-1".to_string(),
            endpoint: Some(endpoint.to_string()),
            access_key_id: Some("test-key".to_string()),
            secret_access_key: Some(Secret::new("test-secret".to_string())),
            path_style,
            prefix: "files".to_string(),
            private_allowed: false,
        }
    }

    /// The address the marker is asked for at.
    async fn marker_address(settings: &ObjectStoreSettings) -> String {
        let recorded = Recorded::default();
        let client = S3::builder(settings, &Arc::default(), &Arc::default())
            .unwrap()
            .with_http_connector(recorded.clone())
            .build()
            .unwrap();
        let s3 = S3 {
            id: Uuid::now_v7().to_string(),
            locator: settings.locator(),
            prefix: settings.prefix.clone(),
            client,
            guarded: Arc::default(),
        };
        assert!(matches!(s3.marker().await, Marker::None));
        let sent = recorded.0.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "{sent:?}");
        sent[0].clone()
    }

    #[tokio::test]
    async fn a_store_addressed_by_path_names_the_bucket_in_the_path() {
        let sent = marker_address(&settings("https://store.invalid:9000", true)).await;
        assert_eq!(
            sent,
            "https://store.invalid:9000/marfa/files/blobs/.marfa-store"
        );
    }

    #[tokio::test]
    async fn a_store_addressed_by_virtual_host_names_the_bucket_in_the_host() {
        let sent = marker_address(&settings("https://store.invalid:9000", false)).await;
        assert_eq!(
            sent,
            "https://marfa.store.invalid:9000/files/blobs/.marfa-store"
        );
        let sent = marker_address(&settings("http://store.invalid/s3", false)).await;
        assert_eq!(
            sent,
            "http://marfa.store.invalid/s3/files/blobs/.marfa-store"
        );
    }

    #[test]
    fn a_store_addressed_by_virtual_host_at_an_address_is_refused() {
        for endpoint in ["http://203.0.113.7:9000", "http://[2001:db8::7]:9000"] {
            let refused =
                S3::new(&settings(endpoint, false), String::new(), &Arc::default()).unwrap_err();
            assert!(!refused.to_string().contains("203.0.113.7"), "{refused}");
            assert!(!refused.to_string().contains("2001:db8"), "{refused}");
            assert_eq!(
                settings(endpoint, false).unaddressable(),
                Some(Unaddressable::Address)
            );
        }
        assert!(
            S3::new(
                &settings("http://203.0.113.7:9000", true),
                String::new(),
                &Arc::default()
            )
            .is_ok()
        );
        assert_eq!(
            settings("http://203.0.113.7:9000", true).unaddressable(),
            None
        );
    }

    #[test]
    fn only_a_bucket_that_can_be_part_of_a_host_goes_before_it() {
        let host = "https://store.example";
        for bucket in [
            "marfa",
            "my-bucket",
            "my.bucket",
            "a",
            "0x",
            &"b".repeat(63),
        ] {
            assert_eq!(
                virtual_host(bucket, host),
                Ok(format!("https://{bucket}.store.example")),
                "{bucket}"
            );
        }
        for bucket in [
            "tenant:bucket",
            "My_Bucket",
            "Marfa",
            "-marfa",
            "marfa-",
            "my..bucket",
            ".marfa",
            "marfa.",
            "my.-bucket",
            &"b".repeat(64),
        ] {
            assert_eq!(
                virtual_host(bucket, host),
                Err(Unaddressable::Bucket),
                "{bucket}"
            );
        }
        let host = ["a", "b", "c"].map(|letter| letter.repeat(63)).join(".");
        let endpoint = format!("https://{host}.{}", "e".repeat(59));
        assert_eq!(
            virtual_host("d", &endpoint).map(|url| url.len()),
            Ok(8 + 253)
        );
        assert_eq!(virtual_host("dd", &endpoint), Err(Unaddressable::Long));
    }

    #[test]
    fn a_host_is_counted_as_a_resolver_counts_it() {
        let host = ["a", "b", "c"].map(|letter| letter.repeat(63)).join(".");
        let at_limit = format!("{host}.{}", "e".repeat(59));
        assert_eq!(
            virtual_host("d", &format!("https://{at_limit}.")).map(|url| url.len()),
            Ok(8 + 253 + 1),
            "one dot at the end names the root"
        );
        assert_eq!(
            virtual_host("dd", &format!("https://{at_limit}.")),
            Err(Unaddressable::Long)
        );
        let short = format!("{host}.{}", "e".repeat(50));
        for dots in ["..", "...", "........"] {
            assert_eq!(
                virtual_host("d", &format!("https://{short}{dots}")),
                Err(Unaddressable::Host),
                "{dots}"
            );
        }
        for endpoint in [
            "https://s3..store.example",
            "https://.store.example",
            "https://store..example.",
            &format!("https://{}.example", "s".repeat(64)),
        ] {
            assert_eq!(
                virtual_host("marfa", endpoint),
                Err(Unaddressable::Host),
                "{endpoint}"
            );
        }
        assert_eq!(
            virtual_host("marfa", &format!("https://{}.example", "s".repeat(63))),
            Ok(format!("https://marfa.{}.example", "s".repeat(63)))
        );
        assert_eq!(
            virtual_host("marfa", "https://store.example."),
            Ok("https://marfa.store.example.".to_string())
        );
    }

    #[test]
    fn the_endpoint_is_taken_as_the_bare_service_host() {
        assert_eq!(
            virtual_host("s3", "https://s3.store.example"),
            Ok("https://s3.s3.store.example".to_string())
        );
        assert_eq!(
            virtual_host("marfa", "https://marfa.store.example"),
            Ok("https://marfa.marfa.store.example".to_string())
        );
    }

    #[tokio::test]
    async fn a_link_the_store_signs_follows_its_address() {
        let path = S3::new(
            &settings("https://store.invalid:9000", true),
            String::new(),
            &Arc::default(),
        )
        .unwrap();
        let link = url::Url::parse(
            &path
                .link("ab/cd", Duration::from_secs(60), Duration::from_secs(5))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(link.host_str(), Some("store.invalid"));
        assert!(link.path().starts_with("/marfa/files/"), "{link}");

        let host = S3::new(
            &settings("https://store.invalid:9000", false),
            String::new(),
            &Arc::default(),
        )
        .unwrap();
        let link = url::Url::parse(
            &host
                .link("ab/cd", Duration::from_secs(60), Duration::from_secs(5))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(link.host_str(), Some("marfa.store.invalid"));
        assert!(link.path().starts_with("/files/"), "{link}");
    }

    /// The `Host` of each request a loopback listener is sent, answered `404`.
    async fn hosts_asked() -> (u16, Arc<Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut request = vec![0u8; 8192];
                let read = socket.read(&mut request).await.unwrap_or(0);
                let text = String::from_utf8_lossy(&request[..read]).to_string();
                let host = text
                    .lines()
                    .find_map(|line| line.strip_prefix("host: ").or(line.strip_prefix("Host: ")))
                    .unwrap_or_default()
                    .to_string();
                seen.lock().unwrap().push(host);
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                    )
                    .await;
            }
        });
        (port, asked)
    }

    #[tokio::test]
    async fn a_bucket_host_is_reached_only_where_its_addresses_are_public() {
        let (port, asked) = hosts_asked().await;
        let faults = Arc::new(Faults::default());
        let guarded = settings(&format!("http://store.test:{port}"), false);
        faults
            .set("resolve:marfa.store.test", Some("127.0.0.1"))
            .unwrap();
        let s3 = S3::new(&guarded, String::new(), &faults).unwrap();
        let marker = s3.marker().await;
        assert!(
            matches!(marker, Marker::Silent(_) | Marker::Refused(_)),
            "{marker:?}"
        );
        assert!(asked.lock().unwrap().is_empty());

        faults
            .set("resolve:marfa.store.test", Some("93.184.216.34>127.0.0.1"))
            .unwrap();
        let s3 = S3::new(&guarded, String::new(), &faults).unwrap();
        assert!(matches!(s3.marker().await, Marker::None));
        assert_eq!(*asked.lock().unwrap(), [format!("marfa.store.test:{port}")]);
    }

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
            guarded: Arc::default(),
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
