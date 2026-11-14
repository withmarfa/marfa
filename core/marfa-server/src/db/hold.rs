//! A refusal every write a request makes meets at once while a long job holds the writer, except the job's own.

use std::future::Future;
use std::sync::Arc;

use tokio::sync::watch;

use crate::app::refusal::Refusal;

tokio::task_local! {
    static PERMIT: Arc<Armed>;
}

pub(super) struct Armed {
    refusal: Refusal,
}

pub(super) struct Hold {
    armed: watch::Sender<Option<Arc<Armed>>>,
}

impl Default for Hold {
    fn default() -> Hold {
        Hold {
            armed: watch::Sender::new(None),
        }
    }
}

/// The refusal a write from the current task meets: none when nothing is held, or the task holds the permit.
fn refused(armed: &Option<Arc<Armed>>) -> Option<Refusal> {
    let armed = armed.as_ref()?;
    let permitted = PERMIT
        .try_with(|permit| Arc::ptr_eq(permit, armed))
        .unwrap_or(false);
    (!permitted).then(|| armed.refusal.clone())
}

impl Hold {
    /// Refuses while another hold is armed, with that hold's refusal.
    pub(super) fn arm(self: &Arc<Hold>, refusal: Refusal) -> Result<Holding, Refusal> {
        let armed = Arc::new(Armed { refusal });
        let mut taken = None;
        self.armed.send_if_modified(|current| match current {
            Some(other) => {
                taken = Some(other.refusal.clone());
                false
            }
            None => {
                *current = Some(armed.clone());
                true
            }
        });
        match taken {
            Some(refusal) => Err(refusal),
            None => Ok(Holding {
                hold: self.clone(),
                armed,
            }),
        }
    }

    pub(super) fn armed(&self) -> Option<Refusal> {
        self.armed
            .borrow()
            .as_ref()
            .map(|armed| armed.refusal.clone())
    }

    pub(super) fn refusal(&self) -> Option<Refusal> {
        refused(&self.armed.borrow())
    }

    /// Runs `enqueue` only if the current task may write, and never while a hold is being armed.
    pub(super) fn admit<R>(&self, enqueue: impl FnOnce() -> R) -> Result<R, Refusal> {
        let armed = self.armed.borrow();
        match refused(&armed) {
            Some(refusal) => Err(refusal),
            None => Ok(enqueue()),
        }
    }

    /// Answers once the current task's writes would be refused.
    pub(super) async fn refusing(&self) -> Refusal {
        let mut armed = self.armed.subscribe();
        loop {
            if let Some(refusal) = refused(&armed.borrow_and_update()) {
                return refusal;
            }
            if armed.changed().await.is_err() {
                return std::future::pending().await;
            }
        }
    }
}

/// Lifts its hold when dropped, by a return, an error or a panic.
pub struct Holding {
    hold: Arc<Hold>,
    armed: Arc<Armed>,
}

impl Holding {
    pub fn permit(&self) -> Permit {
        Permit(self.armed.clone())
    }
}

/// Lets a hold's own writes through it; passes nothing once its hold is lifted.
pub struct Permit(Arc<Armed>);

impl Permit {
    /// Runs `work` with the permit, for the writes it makes on its own task.
    pub fn run<F: Future>(self, work: F) -> impl Future<Output = F::Output> {
        PERMIT.scope(self.0, work)
    }
}

impl Drop for Holding {
    fn drop(&mut self) {
        self.hold.armed.send_if_modified(|current| {
            let mine = current
                .as_ref()
                .is_some_and(|armed| Arc::ptr_eq(armed, &self.armed));
            if mine {
                *current = None;
            }
            mine
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::refusal::Code;

    fn refusal(message: &'static str) -> Refusal {
        Refusal::new(Code::WriteContention, message)
    }

    #[tokio::test]
    async fn refuses_others_and_permits_the_holder_until_dropped() {
        let hold = Arc::new(Hold::default());
        assert!(hold.refusal().is_none());
        let holding = hold.arm(refusal("held")).unwrap();
        assert!(hold.refusal().is_some());
        assert!(hold.admit(|| ()).is_err());
        let inside = holding
            .permit()
            .run(async { (hold.refusal().is_none(), hold.admit(|| ()).is_ok()) })
            .await;
        assert_eq!(inside, (true, true));
        assert!(hold.armed().is_some());
        drop(holding);
        assert!(hold.refusal().is_none());
        assert!(hold.admit(|| ()).is_ok());
    }

    #[tokio::test]
    async fn a_second_hold_is_refused_and_lifts_nothing() {
        let hold = Arc::new(Hold::default());
        let first = hold.arm(refusal("first")).unwrap();
        let second = first
            .permit()
            .run(async { hold.arm(refusal("second")).err() })
            .await;
        assert_eq!(second.map(|r| r.message.to_string()), Some("first".into()));
        assert!(hold.armed().is_some());
        drop(first);
        assert!(hold.armed().is_none());
    }

    #[tokio::test]
    async fn a_permit_from_a_lifted_hold_does_not_pass_a_newer_one() {
        let hold = Arc::new(Hold::default());
        let older = hold.arm(refusal("older")).unwrap();
        let stale = older.permit();
        drop(older);
        let _newer = hold.arm(refusal("newer")).unwrap();
        let met = stale.run(async { hold.refusal() }).await;
        assert_eq!(met.map(|r| r.message.to_string()), Some("newer".into()));
    }

    #[test]
    fn lifts_when_the_holder_panics() {
        let hold = Arc::new(Hold::default());
        let inner = hold.clone();
        let outcome = std::panic::catch_unwind(move || {
            let _holding = inner.arm(refusal("held")).unwrap();
            panic!("job failed");
        });
        assert!(outcome.is_err());
        assert!(hold.armed().is_none());
    }

    #[tokio::test]
    async fn a_waiter_hears_the_hold_armed() {
        let hold = Arc::new(Hold::default());
        let waiting = tokio::spawn({
            let hold = hold.clone();
            async move { hold.refusing().await }
        });
        tokio::task::yield_now().await;
        let _holding = hold.arm(refusal("held")).unwrap();
        let heard = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(heard.message, "held");
    }
}
