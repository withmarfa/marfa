//! Slots for host-name lookups, so one kind of caller, or one maker, cannot use up another's.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use tokio::sync::watch;

use super::fair::{AtDeadline, Held, Joined, Pool};

/// How long a lookup may take, and how long a caller waits before its maker's full share counts.
pub const BOUND: Duration = Duration::from_secs(3);

/// Half of the sender's 64 attempts: a lookup is only the first part of an attempt.
const DELIVERY_TOTAL: usize = 32;
/// Half of the sender's 8 attempts for a maker, so eight makers fill the lane as they fill the sender.
const DELIVERY_PER_MAKER: usize = 4;
const REGISTRATION_TOTAL: usize = 8;
const REGISTRATION_PER_MAKER: usize = 2;
const CLIENT_DOCUMENT_TOTAL: usize = 4;
const MCP_FETCH_TOTAL: usize = 4;

/// Who asks for a lookup; each kind has slots of its own.
#[derive(Clone, Copy, Debug)]
pub enum Asker<'a> {
    /// A webhook delivery, by the maker of its subscription.
    Delivery(&'a str),
    /// A webhook registration or change, by the maker.
    Registration(&'a str),
    ClientDocument,
    McpFetch,
}

pub(super) struct Lane {
    pool: Arc<Pool>,
    /// A patient lane gives up waiting only when the maker's own share is full.
    pub(super) patient: bool,
}

impl Lane {
    pub(super) fn new(total: usize, per_maker: Option<usize>, patient: bool) -> Lane {
        Lane {
            pool: Pool::new(total, per_maker),
            patient,
        }
    }

    /// `None` when the wait ran out. A patient lane checks every `wait` and stays while its maker has room.
    pub(super) async fn take(&self, maker: Option<&str>, wait: Duration) -> Option<Held> {
        let mut place = match self.pool.join(maker.unwrap_or_default()) {
            Joined::Held(held) => return Some(held),
            Joined::Queued(place) => place,
        };
        let mut deadline = tokio::time::Instant::now() + wait;
        loop {
            if let Ok(held) = tokio::time::timeout_at(deadline, &mut place).await {
                return Some(held);
            }
            match place.at_deadline(!self.patient) {
                AtDeadline::Served(held) => return Some(held),
                AtDeadline::Left => return None,
                AtDeadline::Stays => deadline += wait,
            }
        }
    }

    fn share_is_free(&self, maker: &str) -> bool {
        self.pool.has_room(maker)
    }

    #[cfg(test)]
    pub(super) fn free(&self) -> usize {
        self.pool.free()
    }
}

/// Changes each time a delivery lookup slot is given back.
pub fn deliveries_released() -> watch::Receiver<u64> {
    DELIVERY.pool.released()
}

/// Whether the maker's lookups under way hold fewer delivery slots than its share.
pub fn delivery_share_is_free(maker: &str) -> bool {
    DELIVERY.share_is_free(maker)
}

static DELIVERY: LazyLock<Lane> =
    LazyLock::new(|| Lane::new(DELIVERY_TOTAL, Some(DELIVERY_PER_MAKER), true));
static REGISTRATION: LazyLock<Lane> =
    LazyLock::new(|| Lane::new(REGISTRATION_TOTAL, Some(REGISTRATION_PER_MAKER), false));
static CLIENT_DOCUMENT: LazyLock<Lane> =
    LazyLock::new(|| Lane::new(CLIENT_DOCUMENT_TOTAL, None, false));
static MCP_FETCH: LazyLock<Lane> = LazyLock::new(|| Lane::new(MCP_FETCH_TOTAL, None, false));

impl<'a> Asker<'a> {
    pub(super) fn lane(self) -> &'static Lane {
        match self {
            Asker::Delivery(_) => &DELIVERY,
            Asker::Registration(_) => &REGISTRATION,
            Asker::ClientDocument => &CLIENT_DOCUMENT,
            Asker::McpFetch => &MCP_FETCH,
        }
    }

    pub(super) fn maker(self) -> Option<&'a str> {
        match self {
            Asker::Delivery(maker) | Asker::Registration(maker) => Some(maker),
            Asker::ClientDocument | Asker::McpFetch => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_slot_given_back_is_counted_for_whoever_waits() {
        let lane = Lane::new(1, Some(1), false);
        let released = lane.pool.released();
        let slot = lane.take(Some("a"), BOUND).await.unwrap();
        assert_eq!(*released.borrow(), 0);
        drop(slot);
        assert_eq!(*released.borrow(), 1);
    }

    #[tokio::test]
    async fn a_makers_share_is_free_once_its_slots_are_back() {
        let lane = Lane::new(4, Some(1), true);
        assert!(lane.share_is_free("a"));
        let slot = lane.take(Some("a"), BOUND).await.unwrap();
        assert!(!lane.share_is_free("a"));
        assert!(lane.share_is_free("b"));
        drop(slot);
        assert!(lane.share_is_free("a"));
    }

    #[tokio::test]
    async fn a_patient_lane_waits_past_its_bound_for_the_pool_while_the_maker_has_room() {
        const WAIT: Duration = Duration::from_millis(20);
        let lane = Arc::new(Lane::new(1, Some(4), true));
        let other = lane.take(Some("other"), WAIT).await.unwrap();
        let waiting = {
            let lane = lane.clone();
            tokio::spawn(async move { lane.take(Some("a"), WAIT).await.is_some() })
        };
        tokio::time::sleep(WAIT * 8).await;
        assert!(!waiting.is_finished());
        drop(other);
        assert!(waiting.await.unwrap());
    }
}
