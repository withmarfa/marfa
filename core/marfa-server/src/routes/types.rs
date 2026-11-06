use axum::Router;

use crate::app::App;

pub fn router() -> Router<App> {
    Router::new()
}
