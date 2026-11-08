//! The object store: one object per blob under `<prefix>/<hex>`, and a marker object that
//! holds the store's id.

use std::io;
use std::time::Duration;

use bytes::Bytes;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use object_store::aws::{AmazonS3, AmazonS3Builder};
use object_store::path::Path;
use object_store::signer::Signer;
use object_store::{
    Attribute, Attributes, BackoffConfig, ClientOptions, GetOptions, GetRange, ObjectStore,
    ObjectStoreExt, PutMultipartOptions, PutOptions, PutPayload, RetryConfig, WriteMultipart,
};
use uuid::Uuid;

use super::hash::Hash;
use crate::settings::start::ObjectStoreSettings;

/// The most bytes sent in one request; a larger blob goes up in parts of this size.
const PART: usize = 8 * 1024 * 1024;
const PARTS_IN_FLIGHT: usize = 2;
const MARKER: &str = ".marfa-store";

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

/// The bytes of one blob as an object store takes them back.
pub fn attributes(mime_type: &str, hash: &Hash) -> Attributes {
    let mut attributes = Attributes::new();
    attributes.insert(Attribute::ContentType, mime_type.to_string().into());
    attributes.insert(
        Attribute::ContentDisposition,
        format!("attachment; filename=\"{}\"", hash.hex()).into(),
    );
    attributes
}

impl S3 {
    pub fn client(settings: &ObjectStoreSettings) -> io::Result<AmazonS3> {
        let retry = RetryConfig {
            backoff: BackoffConfig::default(),
            max_retries: 2,
            retry_timeout: Duration::from_secs(10),
        };
        let mut builder = AmazonS3Builder::new()
            .with_bucket_name(&settings.bucket)
            .with_region(&settings.region)
            .with_retry(retry)
            .with_client_options(ClientOptions::new().with_connect_timeout(Duration::from_secs(5)));
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

    /// Reads the store's id from its marker object, writing one where there is none.
    pub async fn open(settings: &ObjectStoreSettings) -> io::Result<S3> {
        let client = S3::client(settings)?;
        let marker = Path::from(format!("{}/{MARKER}", settings.prefix));
        let id = match client.get(&marker).await {
            Ok(found) => {
                let text = found.bytes().await.map_err(failed)?;
                let text = String::from_utf8_lossy(&text);
                Uuid::parse_str(text.trim())
                    .map_err(|_| io::Error::other("the store's marker does not hold a store id"))?
                    .to_string()
            }
            Err(error) if is_missing(&error) => {
                let id = Uuid::now_v7().to_string();
                client
                    .put(&marker, PutPayload::from(id.clone().into_bytes()))
                    .await
                    .map_err(failed)?;
                id
            }
            Err(error) => return Err(failed(error)),
        };
        Ok(S3 {
            id,
            locator: settings.locator(),
            prefix: settings.prefix.clone(),
            client,
        })
    }

    /// A store reached at start without its marker: the one the copy record names here.
    pub fn known(settings: &ObjectStoreSettings, id: String) -> io::Result<S3> {
        Ok(S3 {
            id,
            locator: settings.locator(),
            prefix: settings.prefix.clone(),
            client: S3::client(settings)?,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn locator(&self) -> &str {
        &self.locator
    }

    fn path_of(&self, hash: &Hash) -> Path {
        Path::from(format!("{}/{}", self.prefix, hash.hex()))
    }

    pub async fn size_of(&self, hash: &Hash) -> io::Result<Option<u64>> {
        match self.client.head(&self.path_of(hash)).await {
            Ok(meta) => Ok(Some(meta.size)),
            Err(error) if is_missing(&error) => Ok(None),
            Err(error) => Err(failed(error)),
        }
    }

    pub async fn read(
        &self,
        hash: &Hash,
        first: u64,
        length: u64,
    ) -> io::Result<BoxStream<'static, io::Result<Bytes>>> {
        let options = GetOptions {
            range: Some(GetRange::Bounded(first..first + length)),
            ..GetOptions::default()
        };
        let found = self
            .client
            .get_opts(&self.path_of(hash), options)
            .await
            .map_err(failed)?;
        Ok(found.into_stream().map_err(failed).boxed())
    }

    /// Sends the bytes and keeps them only if they hash to `hash`; a short body is sent
    /// whole, so nothing is placed before it is checked.
    pub async fn write(
        &self,
        hash: &Hash,
        mime_type: &str,
        size: u64,
        mut bytes: BoxStream<'static, io::Result<Bytes>>,
    ) -> io::Result<()> {
        let mut hasher = super::store::Hasher::default();
        let location = self.path_of(hash);
        if size <= PART as u64 {
            let mut whole = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk?;
                hasher.update(&chunk);
                whole.extend_from_slice(&chunk);
            }
            hasher.matches(hash, size)?;
            let options = PutOptions {
                attributes: attributes(mime_type, hash),
                ..PutOptions::default()
            };
            self.client
                .put_opts(&location, PutPayload::from(whole), options)
                .await
                .map_err(failed)?;
            return Ok(());
        }
        let options = PutMultipartOptions {
            attributes: attributes(mime_type, hash),
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

    pub async fn delete(&self, hash: &Hash) -> io::Result<()> {
        match self.client.delete(&self.path_of(hash)).await {
            Ok(()) => Ok(()),
            Err(error) if is_missing(&error) => Ok(()),
            Err(error) => Err(failed(error)),
        }
    }

    /// A link the store serves itself, signed with the store's own clock.
    pub async fn link(&self, hash: &Hash, ttl: Duration) -> io::Result<String> {
        self.client
            .signed_url(axum::http::Method::GET, &self.path_of(hash), ttl)
            .await
            .map(|url| url.to_string())
            .map_err(failed)
    }
}
