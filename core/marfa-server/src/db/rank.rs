//! `bm25_within(fts, entries, tokens, hits per phrase...)`: FTS5's `bm25` over a given corpus.

use std::ffi::c_int;
use std::ptr;

use rusqlite::types::Type;
use rusqlite::{Connection, ffi};

// FTS5's own constants, so a corpus of the whole table ranks exactly as `bm25` does.
const K1: f64 = 1.2;
const B: f64 = 0.75;
const LEAST_IDF: f64 = 1e-6;

fn unreadable(reason: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, Type::Blob, reason.into())
}

/// The length of an entry from its `<table>_docsize` sizes, one SQLite varint per column.
pub fn tokens_of(mut sizes: &[u8]) -> rusqlite::Result<i64> {
    let mut total: i64 = 0;
    while !sizes.is_empty() {
        let mut value: u64 = 0;
        let mut read = 0;
        for (at, byte) in sizes.iter().enumerate() {
            read = at + 1;
            if at == 8 {
                value = (value << 8) | u64::from(*byte);
                break;
            }
            value = (value << 7) | u64::from(byte & 0x7f);
            if byte & 0x80 == 0 {
                break;
            }
            if read == sizes.len() {
                return Err(unreadable("a token count is cut short"));
            }
        }
        let value = i64::try_from(value).map_err(|_| unreadable("a token count is too large"))?;
        total = total
            .checked_add(value)
            .ok_or_else(|| unreadable("the token counts overflow"))?;
        sizes = &sizes[read..];
    }
    Ok(total)
}

/// # Safety
/// `api`, `fts` and `values` are what FTS5 passed to the current call.
unsafe fn score(
    api: &ffi::Fts5ExtensionApi,
    fts: *mut ffi::Fts5Context,
    count: c_int,
    values: *mut *mut ffi::sqlite3_value,
) -> Result<f64, c_int> {
    let (Some(phrases), Some(instances), Some(instance), Some(size)) =
        (api.xPhraseCount, api.xInstCount, api.xInst, api.xColumnSize)
    else {
        return Err(ffi::SQLITE_ERROR);
    };
    // SAFETY: `fts` is the context of the current call, as for every call below.
    let phrases = usize::try_from(unsafe { phrases(fts) }).map_err(|_| ffi::SQLITE_ERROR)?;
    let count = usize::try_from(count).map_err(|_| ffi::SQLITE_MISUSE)?;
    if count != phrases + 2 || values.is_null() {
        return Err(ffi::SQLITE_MISUSE);
    }
    // SAFETY: SQLite passes `count` values, valid for the call.
    let values = unsafe { std::slice::from_raw_parts(values, count) };
    let number = |at: usize| -> Result<f64, c_int> {
        let value = values.get(at).ok_or(ffi::SQLITE_MISUSE)?;
        // SAFETY: each value is a live argument of the call.
        Ok(unsafe { ffi::sqlite3_value_int64(*value) } as f64)
    };
    let (entries, tokens) = (number(0)?, number(1)?);
    if entries <= 0.0 || tokens <= 0.0 {
        return Err(ffi::SQLITE_MISMATCH);
    }
    let average = tokens / entries;

    let mut frequency = vec![0.0f64; phrases];
    let mut found: c_int = 0;
    // SAFETY: as above.
    let rc = unsafe { instances(fts, &mut found) };
    if rc != ffi::SQLITE_OK {
        return Err(rc);
    }
    for at in 0..found {
        let (mut phrase, mut column, mut offset) = (0, 0, 0);
        // SAFETY: as above, for an instance below the count FTS5 gave.
        let rc = unsafe { instance(fts, at, &mut phrase, &mut column, &mut offset) };
        if rc != ffi::SQLITE_OK {
            return Err(rc);
        }
        if let Some(held) = usize::try_from(phrase)
            .ok()
            .and_then(|phrase| frequency.get_mut(phrase))
        {
            *held += 1.0;
        }
    }
    let mut length: c_int = 0;
    // SAFETY: as above.
    let rc = unsafe { size(fts, -1, &mut length) };
    if rc != ffi::SQLITE_OK {
        return Err(rc);
    }
    let length = f64::from(length);

    let mut score = 0.0;
    for (at, frequency) in frequency.iter().enumerate() {
        let hits = number(at + 2)?;
        let idf = ((entries - hits + 0.5) / (hits + 0.5)).ln();
        let idf = if idf <= 0.0 { LEAST_IDF } else { idf };
        score +=
            idf * ((frequency * (K1 + 1.0)) / (frequency + K1 * (1.0 - B + B * length / average)));
    }
    Ok(score)
}

unsafe extern "C" fn bm25_within(
    api: *const ffi::Fts5ExtensionApi,
    fts: *mut ffi::Fts5Context,
    context: *mut ffi::sqlite3_context,
    count: c_int,
    values: *mut *mut ffi::sqlite3_value,
) {
    // SAFETY: FTS5 passes valid pointers for the length of the call.
    unsafe {
        match score(&*api, fts, count, values) {
            Ok(score) => ffi::sqlite3_result_double(context, -score),
            Err(code) => ffi::sqlite3_result_error_code(context, code),
        }
    }
}

fn failure(code: c_int, message: &str) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(ffi::Error::new(code), Some(message.to_string()))
}

pub fn register(conn: &Connection) -> rusqlite::Result<()> {
    let mut api: *mut ffi::fts5_api = ptr::null_mut();
    // SAFETY: the handle is valid while `conn` lives, and the statement is finalized here.
    unsafe {
        let db = conn.handle();
        let mut statement = ptr::null_mut();
        let rc = ffi::sqlite3_prepare_v2(
            db,
            c"SELECT fts5(?1)".as_ptr(),
            -1,
            &mut statement,
            ptr::null_mut(),
        );
        if rc != ffi::SQLITE_OK {
            return Err(failure(rc, "FTS5 is not available"));
        }
        ffi::sqlite3_bind_pointer(
            statement,
            1,
            (&raw mut api).cast(),
            c"fts5_api_ptr".as_ptr(),
            None,
        );
        ffi::sqlite3_step(statement);
        ffi::sqlite3_finalize(statement);
    }
    if api.is_null() {
        return Err(failure(ffi::SQLITE_ERROR, "FTS5 gave no API"));
    }
    // SAFETY: FTS5 gave a valid API, which lives as long as the connection.
    let rc = unsafe {
        let Some(create) = (*api).xCreateFunction else {
            return Err(failure(ffi::SQLITE_ERROR, "FTS5 takes no functions"));
        };
        create(
            api,
            c"bm25_within".as_ptr(),
            ptr::null_mut(),
            Some(bm25_within),
            None,
        )
    };
    if rc != ffi::SQLITE_OK {
        return Err(failure(rc, "bm25_within could not be registered"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXTS: [&str; 6] = [
        "the quick brown fox|jumps over the lazy dog",
        "quick quick quick|brown",
        "a slow dog sleeps|in the warm sun all day long without a care",
        "foxes and dogs|are rarely friends",
        "brown bread|",
        "the fox, the dog and the quick reply|",
    ];

    fn rowid(at: usize) -> i64 {
        at as i64 * 3 + 1
    }

    fn indexed(kept: impl Fn(i64) -> bool) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        register(&conn).unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(a, b, tokenize = 'porter unicode61');",
        )
        .unwrap();
        for (at, text) in TEXTS.iter().enumerate() {
            if !kept(rowid(at)) {
                continue;
            }
            let (a, b) = text.split_once('|').unwrap_or((text, ""));
            conn.execute(
                "INSERT INTO t (rowid, a, b) VALUES (?1, ?2, ?3)",
                rusqlite::params![rowid(at), a, b],
            )
            .unwrap();
        }
        conn
    }

    /// The statistics of the entries `kept` keeps, as `bm25_within` takes them.
    fn within(conn: &Connection, phrases: &[&str], kept: &[i64]) -> String {
        let listed: Vec<String> = kept.iter().map(ToString::to_string).collect();
        let listed = listed.join(", ");
        let (entries, tokens) = conn
            .prepare(&format!(
                "SELECT id, sz FROM t_docsize WHERE id IN ({listed})"
            ))
            .unwrap()
            .query_map([], |row| Ok(tokens_of(&row.get::<_, Vec<u8>>(1)?).unwrap()))
            .unwrap()
            .fold((0, 0), |(entries, tokens), size| {
                (entries + 1, tokens + size.unwrap())
            });
        let mut arguments = vec![entries.to_string(), tokens.to_string()];
        for phrase in phrases {
            let hits: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM t WHERE t MATCH ?1 AND rowid IN ({listed})"),
                    [phrase],
                    |row| row.get(0),
                )
                .unwrap();
            arguments.push(hits.to_string());
        }
        format!("bm25_within(t, {})", arguments.join(", "))
    }

    fn ranked(conn: &Connection, query: &str, rank: &str) -> Vec<(i64, f64)> {
        conn.prepare(&format!(
            "SELECT rowid, {rank} FROM t WHERE t MATCH ?1 ORDER BY rowid"
        ))
        .unwrap()
        .query_map([query], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }

    fn close(left: &[(i64, f64)], right: &[(i64, f64)]) {
        assert_eq!(left.len(), right.len(), "{left:?} {right:?}");
        assert!(!left.is_empty());
        for ((a, x), (b, y)) in left.iter().zip(right) {
            assert_eq!(a, b);
            assert!((x - y).abs() <= 1e-12 * x.abs().max(1.0), "{x} {y}");
        }
    }

    const QUERIES: [&[&str]; 3] = [&["\"quick\""], &["\"brown\"", "\"fox\"*"], &["\"the dog\""]];

    #[test]
    fn the_whole_table_as_corpus_ranks_as_bm25_does() {
        let conn = indexed(|_| true);
        let every: Vec<i64> = (0..TEXTS.len()).map(rowid).collect();
        for phrases in QUERIES {
            let query = phrases.join(" ");
            close(
                &ranked(&conn, &query, "bm25(t)"),
                &ranked(&conn, &query, &within(&conn, phrases, &every)),
            );
        }
    }

    #[test]
    fn a_corpus_ranks_as_bm25_over_a_table_of_only_its_entries() {
        let kept = [1, 4, 13, 16];
        let conn = indexed(|_| true);
        let alone = indexed(|rowid| kept.contains(&rowid));
        for phrases in QUERIES {
            let query = phrases.join(" ");
            let mine: Vec<(i64, f64)> = ranked(&conn, &query, &within(&conn, phrases, &kept))
                .into_iter()
                .filter(|(rowid, _)| kept.contains(rowid))
                .collect();
            close(&ranked(&alone, &query, "bm25(t)"), &mine);
        }
    }

    #[test]
    fn a_count_for_each_phrase_is_required() {
        let conn = indexed(|_| true);
        let refused = conn.query_row(
            "SELECT bm25_within(t, 6, 40) FROM t WHERE t MATCH '\"quick\"'",
            [],
            |row| row.get::<_, f64>(0),
        );
        assert!(refused.is_err());
    }

    #[test]
    fn token_counts_read_every_varint_and_refuse_a_cut_one() {
        assert_eq!(tokens_of(&[3, 0, 0x81, 0x00]).unwrap(), 3 + 128);
        assert!(tokens_of(&[0x81]).is_err());
    }
}
