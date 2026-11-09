use marfa_server::app::{App, stored};
use marfa_server::db::Write;

/// Commits a stored setting and leaves the live settings as they were, as the writer has
/// answered a change it has not yet published.
pub async fn commit_unpublished(app: &App, key: &str, value: &str) {
    let rows = vec![(key.to_string(), Some(value.to_string()))];
    app.db
        .write(Write::own(), move |tx| stored::write_rows(tx, &rows))
        .await
        .unwrap();
}
