use marfa_server::app::{App, stored};
use marfa_server::db::Write;

/// A change the writer has committed and not yet made live.
pub async fn commit_unpublished(app: &App, key: &str, value: &str) {
    let rows = vec![(key.to_string(), Some(value.to_string()))];
    app.db
        .write(Write::own(), move |tx| stored::write_rows(tx, &rows))
        .await
        .unwrap();
}

/// Removes a setting's row as the writer commits it, without making that live.
pub async fn remove_unpublished(app: &App, key: &str) {
    let rows = vec![(key.to_string(), None)];
    app.db
        .write(Write::own(), move |tx| stored::write_rows(tx, &rows))
        .await
        .unwrap();
}
