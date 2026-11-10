//! Removes deliveries past their retention, one bounded write at a time.

use std::sync::Arc;

use serde_json::json;

use super::super::App;
use super::super::faults::FAIL_INBOUND_CLEANUP;
use super::super::housekeeping::{DAY_MS, Report, Run, cutoff};
use super::super::refusal::Result;
use super::store;
use crate::db::{Write, io_refusal};
use crate::settings::registry::{INBOUND_HANDLED_RETENTION_DAYS, INBOUND_PENDING_RETENTION_DAYS};

const BATCH: i64 = 500;
const CHARGE_TARGET: i64 = 32 * 1024 * 1024;

/// Always takes the first delivery so an oversized one cannot block cleanup.
fn chosen(expired: Vec<store::Expired>) -> Vec<i64> {
    let mut seqs = Vec::new();
    let mut held: i64 = 0;
    for delivery in expired {
        if !seqs.is_empty() && delivery.charge > CHARGE_TARGET.saturating_sub(held) {
            break;
        }
        held = held.saturating_add(delivery.charge);
        seqs.push(delivery.seq);
    }
    seqs
}

pub async fn delivery_cleanup(app: Arc<App>, run: Run) -> Result<Report> {
    let faults = app.faults.clone();
    let (live, job) = (app.clone(), run.job);
    let (deleted, remaining) = app
        .db
        .write(Write::own(), move |tx| {
            let handled_before = cutoff(tx, &live, INBOUND_HANDLED_RETENTION_DAYS, DAY_MS)?;
            let pending_before = cutoff(tx, &live, INBOUND_PENDING_RETENTION_DAYS, DAY_MS)?;
            let expired = store::expired(
                tx,
                handled_before.as_deref(),
                pending_before.as_deref(),
                BATCH,
            )?;
            let seqs = chosen(expired);
            for seq in &seqs {
                store::remove(tx, *seq)?;
            }
            if faults.fail(FAIL_INBOUND_CLEANUP, None) {
                return Err(io_refusal());
            }
            let remaining =
                store::any_expired(tx, handled_before.as_deref(), pending_before.as_deref())?;
            if !remaining {
                for (unread, before) in [
                    (&store::UNREAD_HANDLED, handled_before),
                    (&store::UNREAD_PENDING, pending_before),
                ] {
                    if let Some(before) = before {
                        unread.report(tx, job, [before])?;
                    }
                }
            }
            Ok((seqs.len(), remaining))
        })
        .await?;
    Ok(Report::done(
        json!({ "deleted": deleted, "remaining": remaining }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expired(charges: &[i64]) -> Vec<store::Expired> {
        charges
            .iter()
            .zip(1..)
            .map(|(charge, seq)| store::Expired {
                seq,
                charge: *charge,
            })
            .collect()
    }

    #[test]
    fn a_set_of_exactly_the_target_is_taken_and_one_byte_more_is_not() {
        let half = CHARGE_TARGET / 2;
        assert_eq!(chosen(expired(&[half, half, 1])), vec![1, 2]);
        assert_eq!(chosen(expired(&[half, half + 1, 1])), vec![1]);
    }

    #[test]
    fn a_first_delivery_over_the_target_is_still_taken() {
        assert_eq!(chosen(expired(&[CHARGE_TARGET + 1, 1])), vec![1]);
    }
}
