//! The one table every router is built from. In a test build a door cannot be
//! added without being recorded, so `served` is what the router answers.

use std::convert::Infallible;
use std::sync::Arc;

use axum::Router;
use axum::extract::Request;
use axum::handler::Handler;
#[cfg(test)]
use axum::http::Method;
use axum::response::IntoResponse;
use axum::routing::{MethodRouter, Route};
use tower::{Layer, Service};

use crate::app::App;

type Inner = Router<Arc<App>>;

/// A method and the path pattern it is served at, as the router matches it.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Door {
    pub method: Method,
    pub path: &'static str,
}

/// The handlers of one path, each under its method.
pub struct Handlers {
    #[cfg(test)]
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
                    #[cfg(test)]
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
                    #[cfg(test)]
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
        #[cfg(test)]
        self.methods.push(Method::OPTIONS);
        self.router = self.router.options(handler);
        self
    }

    pub fn head<H, T>(mut self, handler: H) -> Self
    where
        H: Handler<T, Arc<App>>,
        T: 'static,
    {
        #[cfg(test)]
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
    #[cfg(test)]
    served: Vec<Door>,
}

impl Doors {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn route(mut self, path: &'static str, handlers: Handlers) -> Self {
        #[cfg(test)]
        self.served.extend(
            handlers
                .methods
                .into_iter()
                .map(|method| Door { method, path }),
        );
        self.router = self.router.route(path, handlers.router);
        self
    }

    pub fn merge(mut self, other: Doors) -> Self {
        #[cfg(test)]
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
