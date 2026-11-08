//! A credential's proof that its working copy was read under unchanged limits.

use rusqlite::Transaction;
use serde_json::{Value, json};

use super::{Axis, Caller};
use crate::app::App;
use crate::app::instance;
use crate::app::query::Secret;
use crate::app::refusal::{Code, Refusal, Result};

const SCOPE: &str = "reach";
const FORM: u8 = 1;

pub fn changed() -> Refusal {
    Refusal::new(
        Code::ReachChanged,
        "The reach changed. Rebuild the working copy.",
    )
}

impl Caller {
    /// Write levels and profile permissions do not change working-copy read authority.
    fn read_authority(&self) -> Result<Value> {
        let grants = self.whole_set();
        Ok(json!({
            "types": Axis::Type.read_form(grants.map(Axis::Type)),
            "edges": Axis::Edge.read_form(grants.map(Axis::Edge)),
            "metadata": Axis::Metadata.read_form(grants.map(Axis::Metadata)),
            "extensions": Axis::Extension.read_form(grants.map(Axis::Extension)),
            "source_filter": self.levers()?.source_filter_form(),
        }))
    }
}

/// Judges a reach in a snapshot. The caller it is given must have been read in that snapshot.
#[derive(Clone)]
pub struct Judge {
    instance_id: String,
    secret: Secret,
}

impl Judge {
    pub fn of(app: &App) -> Judge {
        Judge {
            instance_id: app.instance_id.clone(),
            secret: app.cursor_secret.clone(),
        }
    }

    pub fn instance_id(&self) -> &str {
        &self.instance_id
    }

    pub fn reach(&self, tx: &Transaction<'_>, caller: &Caller) -> Result<String> {
        let form = json!([
            FORM,
            self.instance_id,
            instance::reach_counter(tx)?,
            caller.credential_handle(),
            caller.read_authority()?,
        ]);
        self.secret.certify(SCOPE, &form.to_string())
    }

    /// Refuses a reach other than the credential's current one.
    pub fn require(&self, tx: &Transaction<'_>, caller: &Caller, asked: &str) -> Result<()> {
        if self.reach(tx, caller)? == asked {
            Ok(())
        } else {
            Err(changed())
        }
    }
}

tokio::task_local! {
    static DEMAND: Demand;
}

/// A reach a request presented and every read of the request must find current in its own snapshot.
#[derive(Clone)]
pub struct Demand {
    judge: Judge,
    asked: String,
}

impl Demand {
    pub fn new(judge: Judge, asked: String) -> Demand {
        Demand { judge, asked }
    }

    /// Runs `work` with this demand pending for every read it makes.
    pub async fn within<F: std::future::Future>(self, work: F) -> F::Output {
        DEMAND.scope(self, work).await
    }

    /// The demand of the request this task answers, if it presented a reach.
    pub fn pending() -> Option<Demand> {
        DEMAND.try_with(Clone::clone).ok()
    }

    pub fn verify(&self, tx: &Transaction<'_>, caller: &Caller) -> Result<()> {
        self.judge.require(tx, caller, &self.asked)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::app::access::Standing;

    fn form(axis: Axis, map: Value) -> Value {
        axis.read_form(&axis.from_body(&map).expect("a good map"))
    }

    #[test]
    fn a_write_level_reads_as_a_read_level() {
        let read = form(Axis::Type, json!({ "core.note": "read" }));
        assert_eq!(read, form(Axis::Type, json!({ "core.note": "write" })));
        assert_ne!(read, form(Axis::Type, json!({ "core.note": "none" })));
        assert_ne!(read, form(Axis::Type, json!({})));
    }

    #[test]
    fn an_entry_another_one_already_decides_leaves_the_form_as_it_was() {
        let wide = form(Axis::Type, json!({ "*": "read" }));
        assert_eq!(
            wide,
            form(
                Axis::Type,
                json!({ "*": "write", "core.note": "read", "core.*": "write" })
            )
        );
        let hole = form(Axis::Type, json!({ "*": "read", "core.note": "none" }));
        assert_ne!(wide, hole);
        assert_eq!(
            hole,
            form(
                Axis::Type,
                json!({ "*": "write", "core.note": "none", "core.bookmark": "read" })
            )
        );
        let none = form(Axis::Type, json!({ "core.note": "none" }));
        assert_eq!(none, form(Axis::Type, json!({})));
    }

    #[test]
    fn a_name_a_wildcard_covers_is_the_same_whichever_way_it_is_spelled() {
        let under = form(Axis::Type, json!({ "about.*": "read" }));
        assert_eq!(
            under,
            form(Axis::Type, json!({ "about.*": "write", "about.x": "read" }))
        );
        assert_ne!(
            under,
            form(Axis::Type, json!({ "about.*": "read", "about.x": "none" }))
        );
    }

    #[test]
    fn metadata_and_extensions_read_by_a_default_and_the_names_that_differ() {
        for axis in [Axis::Metadata, Axis::Extension] {
            let read = form(axis, json!({ "x": "read" }));
            assert_eq!(read, form(axis, json!({ "x": "write" })));
            assert_ne!(read, form(axis, json!({ "y": "read" })));
            assert_ne!(read, form(axis, json!({ "*": "read" })));
            assert_eq!(
                form(axis, json!({ "*": "read" })),
                form(axis, json!({ "*": "write", "x": "read" }))
            );
        }
    }

    #[test]
    fn a_source_filter_reads_the_same_in_any_order_and_a_closed_one_differs_from_none() {
        use crate::app::access::Levers;
        let filter = |sources: Value| {
            let levers = Levers::from_body_at(
                &json!({ "source_filter": { "types": ["b", "a", "a"], "sources": sources } }),
                "enforcement",
            )
            .unwrap();
            Standing::of(Some(&levers), None)
                .holding()
                .unwrap()
                .source_filter_form()
        };
        assert_eq!(filter(json!(["y", "x"])), filter(json!(["x", "y", "x"])));
        assert_ne!(filter(json!(["x"])), filter(json!(["y"])));
        assert_ne!(
            filter(json!(["x"])),
            Standing::of(None, None)
                .holding()
                .unwrap()
                .source_filter_form()
        );
        assert_ne!(
            Standing::closed().holding().unwrap().source_filter_form(),
            Standing::of(None, None)
                .holding()
                .unwrap()
                .source_filter_form()
        );
    }
}
