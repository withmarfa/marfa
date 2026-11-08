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

/// A method and the path pattern it is served at, as the router matches it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Door {
    pub method: Method,
    pub path: &'static str,
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
