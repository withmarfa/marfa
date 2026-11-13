//! Every served door is recorded here.

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::handler::Handler;
use axum::http::Method;
use axum::middleware::from_fn_with_state;
use axum::response::IntoResponse;
use axum::routing::{MethodRouter, Route};
use tower::{Layer, Service};

use super::admission::{Admission, admit};
use crate::app::App;

type Inner = Router<Arc<App>>;

pub type Credentials = HashMap<(Method, &'static str), (Asks, Option<Admission>)>;

/// A method and the path pattern it is served at, as the router matches it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Door {
    pub method: Method,
    pub path: &'static str,
}

/// What a door needs presented before the server reads its body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asks {
    /// A token, or the private socket.
    Credential,
    /// A credential, or the owner's session cookie.
    Session,
    /// Nothing, or the door reads the credential itself before the body.
    Nothing,
}

/// The handlers of one path, each under its method.
pub struct Handlers {
    methods: Vec<Method>,
    router: MethodRouter<Arc<App>>,
}

macro_rules! methods {
    ($($name:ident => $method:ident),* $(,)?) => {
        $(
            pub fn $name<H, T>(handler: H) -> Handlers
            where
                H: Handler<T, Arc<App>>,
                T: 'static,
            {
                Handlers {
                    methods: vec![Method::$method],
                    router: axum::routing::$name(handler),
                }
            }
        )*

        impl Handlers {
            $(
                pub fn $name<H, T>(mut self, handler: H) -> Self
                where
                    H: Handler<T, Arc<App>>,
                    T: 'static,
                {
                    self.methods.push(Method::$method);
                    self.router = self.router.$name(handler);
                    self
                }
            )*
        }
    };
}

methods! {
    get => GET,
    post => POST,
    put => PUT,
    patch => PATCH,
    delete => DELETE,
}

impl Handlers {
    pub fn options<H, T>(mut self, handler: H) -> Self
    where
        H: Handler<T, Arc<App>>,
        T: 'static,
    {
        self.methods.push(Method::OPTIONS);
        self.router = self.router.options(handler);
        self
    }

    pub fn head<H, T>(mut self, handler: H) -> Self
    where
        H: Handler<T, Arc<App>>,
        T: 'static,
    {
        self.methods.push(Method::HEAD);
        self.router = self.router.head(handler);
        self
    }

    pub fn layer<L>(mut self, layer: L) -> Self
    where
        L: Layer<Route> + Clone + Send + Sync + 'static,
        L::Service: Service<Request> + Clone + Send + Sync + 'static,
        <L::Service as Service<Request>>::Response: IntoResponse + 'static,
        <L::Service as Service<Request>>::Error: Into<Infallible> + 'static,
        <L::Service as Service<Request>>::Future: Send + 'static,
    {
        self.router = self.router.layer(layer);
        self
    }
}

#[derive(Default)]
pub struct Doors {
    router: Inner,
    paths: Vec<&'static str>,
    unjudged: HashSet<&'static str>,
    refusals: Vec<(Method, &'static str)>,
    admissions: HashMap<(Method, &'static str), Admission>,
    asks: HashMap<(Method, &'static str), Asks>,
    served: Vec<Door>,
}

impl Doors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn route(mut self, path: &'static str, handlers: Handlers) -> Self {
        self.served.extend(
            handlers
                .methods
                .into_iter()
                .map(|method| Door { method, path }),
        );
        self.router = self.router.route(path, handlers.router);
        self.paths.push(path);
        self
    }

    /// Exempts the paths already held from instance-header checks.
    pub fn unjudged(mut self) -> Self {
        self.unjudged.extend(self.paths.iter().copied());
        self
    }

    /// Leaves a method that only refuses itself out of instance-header checks.
    pub fn refusing(mut self, method: Method, path: &'static str) -> Self {
        self.refusals.push((method, path));
        self
    }

    /// The doors held so far ask `asks` rather than a credential.
    pub fn asking(mut self, asks: Asks) -> Self {
        for door in &self.served {
            self.asks.insert((door.method.clone(), door.path), asks);
        }
        self
    }

    pub fn asking_at(mut self, method: Method, path: &'static str, asks: Asks) -> Self {
        self.asks.insert((method, path), asks);
        self
    }

    /// What each door asks before its body is read, and the credentials its group admits.
    pub(super) fn credentials(&self) -> Credentials {
        self.served
            .iter()
            .map(|door| {
                let key = (door.method.clone(), door.path);
                let asks = self.asks.get(&key).copied().unwrap_or(Asks::Credential);
                let admission = self.admissions.get(&key).copied();
                (key, (asks, admission))
            })
            .collect()
    }

    /// Admission and instance checks share the group's credential rule.
    pub fn admitting(mut self, app: Arc<App>, rule: Admission) -> Self {
        self.admissions.extend(
            self.served
                .iter()
                .map(|door| ((door.method.clone(), door.path), rule)),
        );
        self.route_layer(from_fn_with_state((app, rule), admit))
    }

    pub(super) fn judged_writes(&self) -> HashMap<&'static str, Vec<(Method, Admission)>> {
        let mut judged: HashMap<&'static str, Vec<(Method, Admission)>> = HashMap::new();
        for door in &self.served {
            if self.unjudged.contains(door.path)
                || !super::named_instance::is_write(&door.method)
                || self
                    .refusals
                    .iter()
                    .any(|(method, path)| *method == door.method && *path == door.path)
            {
                continue;
            }
            let rule = self
                .admissions
                .get(&(door.method.clone(), door.path))
                .copied()
                .unwrap_or(Admission::Any);
            judged
                .entry(door.path)
                .or_default()
                .push((door.method.clone(), rule));
        }
        judged
    }

    pub fn merge(mut self, other: Doors) -> Self {
        self.paths.extend(other.paths);
        self.unjudged.extend(other.unjudged);
        self.refusals.extend(other.refusals);
        self.admissions.extend(other.admissions);
        self.asks.extend(other.asks);
        self.served.extend(other.served);
        self.router = self.router.merge(other.router);
        self
    }

    pub fn route_layer<L>(mut self, layer: L) -> Self
    where
        L: Layer<Route> + Clone + Send + Sync + 'static,
        L::Service: Service<Request> + Clone + Send + Sync + 'static,
        <L::Service as Service<Request>>::Response: IntoResponse + 'static,
        <L::Service as Service<Request>>::Error: Into<Infallible> + 'static,
        <L::Service as Service<Request>>::Future: Send + 'static,
    {
        self.router = self.router.route_layer(layer);
        self
    }

    /// Every method and path this table routes, in a stable order.
    #[cfg(test)]
    pub fn served(&self) -> Vec<Door> {
        let mut served = self.served.clone();
        served.sort();
        served
    }

    pub(super) fn into_router(self) -> Inner {
        self.router
    }
}
