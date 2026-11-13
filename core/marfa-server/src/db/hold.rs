//! A refusal every new write meets at once while a long job holds the writer.

use std::sync::{Arc, OnceLock};

use arc_swap::ArcSwapOption;

use crate::app::refusal::Refusal;

#[derive(Default)]
pub(super) struct Hold {
    refusal: ArcSwapOption<Refusal>,
}

impl Hold {
    pub(super) fn refusal(&self) -> Option<Refusal> {
        self.refusal.load().as_deref().cloned()
    }
}

/// Clears only its own refusal on drop; keep it alive until the transaction ends.
pub struct Holding {
    hold: Arc<Hold>,
    mine: Arc<OnceLock<Arc<Refusal>>>,
}

/// Arms on the writer thread so the job does not refuse its own submission.
pub struct Begin {
    hold: Arc<Hold>,
    mine: Arc<OnceLock<Arc<Refusal>>>,
}

impl Holding {
    pub(super) fn new(hold: Arc<Hold>) -> Holding {
        Holding {
            hold,
            mine: Arc::default(),
        }
    }

    pub fn begin(&self) -> Begin {
        Begin {
            hold: self.hold.clone(),
            mine: self.mine.clone(),
        }
    }
}

impl Begin {
    pub fn with(&self, refusal: Refusal) {
        let refusal = Arc::new(refusal);
        if self.mine.set(refusal.clone()).is_ok() {
            self.hold.refusal.store(Some(refusal));
        }
    }
}

impl Drop for Holding {
    fn drop(&mut self) {
        if let Some(mine) = self.mine.get() {
            self.hold.refusal.rcu(|current| match current {
                Some(held) if Arc::ptr_eq(held, mine) => None,
                other => other.clone(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::refusal::Code;

    fn refusal(message: &'static str) -> Refusal {
        Refusal::new(Code::WriteContention, message)
    }

    #[test]
    fn refuses_only_between_begin_and_drop() {
        let hold = Arc::new(Hold::default());
        let holding = Holding::new(hold.clone());
        let begin = holding.begin();
        assert!(hold.refusal().is_none());
        begin.with(refusal("held"));
        assert!(hold.refusal().is_some());
        drop(holding);
        assert!(hold.refusal().is_none());
    }

    #[test]
    fn a_guard_never_begun_lifts_nothing() {
        let hold = Arc::new(Hold::default());
        let running = Holding::new(hold.clone());
        running.begin().with(refusal("first"));
        drop(Holding::new(hold.clone()));
        assert!(hold.refusal().is_some());
    }

    #[test]
    fn an_older_guard_does_not_lift_a_newer_refusal() {
        let hold = Arc::new(Hold::default());
        let older = Holding::new(hold.clone());
        older.begin().with(refusal("older"));
        let newer = Holding::new(hold.clone());
        newer.begin().with(refusal("newer"));
        drop(older);
        assert_eq!(
            hold.refusal().map(|r| r.message.to_string()),
            Some("newer".into())
        );
        drop(newer);
        assert!(hold.refusal().is_none());
    }

    #[test]
    fn lifts_when_the_holder_panics() {
        let hold = Arc::new(Hold::default());
        let inner = hold.clone();
        let outcome = std::panic::catch_unwind(move || {
            let holding = Holding::new(inner);
            holding.begin().with(refusal("held"));
            panic!("job failed");
        });
        assert!(outcome.is_err());
        assert!(hold.refusal().is_none());
    }
}
