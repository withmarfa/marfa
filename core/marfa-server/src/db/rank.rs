//! `bm25_within(fts, corpus)`: FTS5's `bm25` with its statistics drawn from a corpus of the
//! table's entries, so a ranking says nothing of the entries outside it.

use std::ffi::{c_int, c_void};
use std::ptr;

use rusqlite::types::Type;
use rusqlite::{Connection, ffi};

// FTS5's own constants, so a corpus of the whole table ranks exactly as `bm25` does.
const K1: f64 = 1.2;
const B: f64 = 0.75;
const LEAST_IDF: f64 = 1e-6;
const HEADER: usize = 24;

/// Entries by rowid, with their count and their total length in tokens.
#[derive(Debug)]
pub struct Corpus {
    first: i64,
    entries: i64,
    tokens: i64,
    held: Vec<u8>,
}

fn unreadable(reason: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(1, Type::Blob, reason.into())
}

/// The token counts FTS5 stores in `<table>_docsize`, one SQLite varint per column.
fn tokens_of(mut sizes: &[u8]) -> rusqlite::Result<i64> {
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

impl Corpus {
    /// From rows of each entry's rowid and its `_docsize` sizes.
    pub fn gather(found: &mut rusqlite::Rows<'_>) -> rusqlite::Result<Corpus> {
        let mut ids = Vec::new();
        let mut tokens: i64 = 0;
        while let Some(row) = found.next()? {
            ids.push(row.get::<_, i64>(0)?);
            let sizes = row
                .get_ref(1)?
                .as_blob_or_null()?
                .ok_or_else(|| unreadable("an entry has no sizes"))?;
            tokens = tokens
                .checked_add(tokens_of(sizes)?)
                .ok_or_else(|| unreadable("the token counts overflow"))?;
        }
        let first = ids.iter().copied().min().unwrap_or(0);
        let last = ids.iter().copied().max().unwrap_or(0);
        let span = last
            .checked_sub(first)
            .and_then(|span| usize::try_from(span / 8 + 1).ok())
            .ok_or_else(|| unreadable("the entries span too far"))?;
        let mut held = vec![0u8; span];
        for id in &ids {
            let at = (id - first) as usize;
            if let Some(byte) = held.get_mut(at / 8) {
                *byte |= 1 << (at % 8);
            }
        }
        Ok(Corpus {
            first,
            entries: ids.len() as i64,
            tokens,
            held,
        })
    }

    /// The argument `bm25_within` takes.
    pub fn encoded(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(HEADER + self.held.len());
        bytes.extend_from_slice(&self.first.to_le_bytes());
        bytes.extend_from_slice(&self.entries.to_le_bytes());
        bytes.extend_from_slice(&self.tokens.to_le_bytes());
        bytes.extend_from_slice(&self.held);
        bytes
    }
}

struct View<'b> {
    first: i64,
    entries: i64,
    tokens: i64,
    held: &'b [u8],
}

impl<'b> View<'b> {
    fn read(bytes: &'b [u8]) -> Option<View<'b>> {
        let word = |at: usize| -> Option<i64> {
            Some(i64::from_le_bytes(bytes.get(at..at + 8)?.try_into().ok()?))
        };
        Some(View {
            first: word(0)?,
            entries: word(8)?,
            tokens: word(16)?,
            held: bytes.get(HEADER..)?,
        })
    }

    fn holds(&self, rowid: i64) -> bool {
        let Some(at) = rowid.checked_sub(self.first).filter(|at| *at >= 0) else {
            return false;
        };
        let Ok(at) = usize::try_from(at) else {
            return false;
        };
        self.held
            .get(at / 8)
            .is_some_and(|byte| byte & (1 << (at % 8)) != 0)
    }
}

struct Stats {
    average: f64,
    idf: Vec<f64>,
    frequency: Vec<f64>,
}

struct Counting<'v, 'b> {
    corpus: &'v View<'b>,
    hits: i64,
}

unsafe extern "C" fn count_hit(
    api: *const ffi::Fts5ExtensionApi,
    fts: *mut ffi::Fts5Context,
    data: *mut c_void,
) -> c_int {
    // SAFETY: FTS5 hands back the `Counting` that `stats` passed, during that call.
    let (api, counting) = unsafe { (&*api, &mut *data.cast::<Counting<'_, '_>>()) };
    let Some(rowid) = api.xRowid else {
        return ffi::SQLITE_ERROR;
    };
    // SAFETY: `fts` is the context FTS5 gave this callback.
    if counting.corpus.holds(unsafe { rowid(fts) }) {
        counting.hits += 1;
    }
    ffi::SQLITE_OK
}

unsafe extern "C" fn drop_stats(stats: *mut c_void) {
    // SAFETY: the pointer is the `Box<Stats>` `stats` gave FTS5, freed once.
    drop(unsafe { Box::from_raw(stats.cast::<Stats>()) });
}

/// The statistics of one query, computed at its first entry and kept for the rest.
unsafe fn stats<'s>(
    api: &ffi::Fts5ExtensionApi,
    fts: *mut ffi::Fts5Context,
    corpus: &View<'_>,
) -> Result<&'s mut Stats, c_int> {
    let (Some(get), Some(set), Some(phrases), Some(query)) = (
        api.xGetAuxdata,
        api.xSetAuxdata,
        api.xPhraseCount,
        api.xQueryPhrase,
    ) else {
        return Err(ffi::SQLITE_ERROR);
    };
    // SAFETY: `fts` is the context of the current call.
    let kept = unsafe { get(fts, 0) }.cast::<Stats>();
    if !kept.is_null() {
        // SAFETY: only `stats` stores auxiliary data for this function, always a `Stats`.
        return Ok(unsafe { &mut *kept });
    }
    if corpus.entries <= 0 || corpus.tokens <= 0 {
        return Err(ffi::SQLITE_MISMATCH);
    }
    let entries = corpus.entries as f64;
    // SAFETY: as above.
    let count = unsafe { phrases(fts) }.max(0);
    let mut idf = Vec::with_capacity(count as usize);
    for phrase in 0..count {
        let mut counting = Counting { corpus, hits: 0 };
        // SAFETY: `counting` outlives the call, which runs the callback synchronously.
        let rc = unsafe { query(fts, phrase, (&raw mut counting).cast(), Some(count_hit)) };
        if rc != ffi::SQLITE_OK {
            return Err(rc);
        }
        let hits = counting.hits as f64;
        let value = ((entries - hits + 0.5) / (hits + 0.5)).ln();
        idf.push(if value <= 0.0 { LEAST_IDF } else { value });
    }
    let made = Box::into_raw(Box::new(Stats {
        average: corpus.tokens as f64 / entries,
        frequency: vec![0.0; idf.len()],
        idf,
    }));
    // SAFETY: FTS5 owns `made` from here and frees it with `drop_stats`, even on failure.
    let rc = unsafe { set(fts, made.cast(), Some(drop_stats)) };
    if rc != ffi::SQLITE_OK {
        return Err(rc);
    }
    // SAFETY: stored above and freed only when the query ends.
    Ok(unsafe { &mut *made })
}

unsafe fn score(
    api: &ffi::Fts5ExtensionApi,
    fts: *mut ffi::Fts5Context,
    count: c_int,
    values: *mut *mut ffi::sqlite3_value,
) -> Result<f64, c_int> {
    if count != 1 || values.is_null() {
        return Err(ffi::SQLITE_MISUSE);
    }
    // SAFETY: SQLite passes `count` values, valid for the call.
    let value = unsafe { *values };
    // SAFETY: as above; the blob stays put while the value is not converted.
    let (blob, length) = unsafe {
        (
            ffi::sqlite3_value_blob(value),
            ffi::sqlite3_value_bytes(value),
        )
    };
    let length = usize::try_from(length).map_err(|_| ffi::SQLITE_MISMATCH)?;
    if blob.is_null() {
        return Err(ffi::SQLITE_MISMATCH);
    }
    // SAFETY: SQLite says the blob holds `length` bytes.
    let bytes = unsafe { std::slice::from_raw_parts(blob.cast::<u8>(), length) };
    let corpus = View::read(bytes).ok_or(ffi::SQLITE_MISMATCH)?;
    // SAFETY: `fts` is the context of the current call.
    let stats = unsafe { stats(api, fts, &corpus) }?;
    let (Some(instances), Some(instance), Some(size)) =
        (api.xInstCount, api.xInst, api.xColumnSize)
    else {
        return Err(ffi::SQLITE_ERROR);
    };
    stats.frequency.fill(0.0);
    let mut found: c_int = 0;
    // SAFETY: as above, for every call on `fts`.
    let rc = unsafe { instances(fts, &mut found) };
    if rc != ffi::SQLITE_OK {
        return Err(rc);
    }
    for at in 0..found {
        let (mut phrase, mut column, mut offset) = (0, 0, 0);
        let rc = unsafe { instance(fts, at, &mut phrase, &mut column, &mut offset) };
        if rc != ffi::SQLITE_OK {
            return Err(rc);
        }
        if let Some(frequency) = usize::try_from(phrase)
            .ok()
            .and_then(|phrase| stats.frequency.get_mut(phrase))
        {
            *frequency += 1.0;
        }
    }
    let mut tokens: c_int = 0;
    let rc = unsafe { size(fts, -1, &mut tokens) };
    if rc != ffi::SQLITE_OK {
        return Err(rc);
    }
    let length = f64::from(tokens);
    let mut score = 0.0;
    for (idf, frequency) in stats.idf.iter().zip(&stats.frequency) {
        score += idf
            * ((frequency * (K1 + 1.0))
                / (frequency + K1 * (1.0 - B + B * length / stats.average)));
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
    // SAFETY: SQLite passes valid pointers for the length of the call.
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
    // SAFETY: FTS5 gave a valid API that lives as long as the connection.
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

    fn indexed(texts: &[&str]) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        register(&conn).unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(a, b, tokenize = 'porter unicode61');",
        )
        .unwrap();
        for (at, text) in texts.iter().enumerate() {
            let (a, b) = text.split_once('|').unwrap_or((text, ""));
            conn.execute(
                "INSERT INTO t (rowid, a, b) VALUES (?1, ?2, ?3)",
                rusqlite::params![at as i64 * 3 + 1, a, b],
            )
            .unwrap();
        }
        conn
    }

    fn corpus(conn: &Connection, rowids: Option<&[i64]>) -> Vec<u8> {
        let kept = match rowids {
            Some(ids) => {
                let ids: Vec<String> = ids.iter().map(ToString::to_string).collect();
                format!(" WHERE id IN ({})", ids.join(", "))
            }
            None => String::new(),
        };
        let mut statement = conn
            .prepare(&format!("SELECT id, sz FROM t_docsize{kept}"))
            .unwrap();
        let mut found = statement.query([]).unwrap();
        Corpus::gather(&mut found).unwrap().encoded()
    }

    fn ranked(conn: &Connection, query: &str, rank: &str, corpus: &[u8]) -> Vec<(i64, f64)> {
        let sql = format!("SELECT rowid, {rank} FROM t WHERE t MATCH ?1 ORDER BY rowid");
        let mut statement = conn.prepare(&sql).unwrap();
        let params: Vec<rusqlite::types::Value> = if rank.contains('?') {
            vec![query.to_string().into(), corpus.to_vec().into()]
        } else {
            vec![query.to_string().into()]
        };
        statement
            .query_map(rusqlite::params_from_iter(params), |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn close(left: &[(i64, f64)], right: &[(i64, f64)]) {
        assert_eq!(left.len(), right.len(), "{left:?} {right:?}");
        for ((a, x), (b, y)) in left.iter().zip(right) {
            assert_eq!(a, b);
            assert!((x - y).abs() <= 1e-12 * x.abs().max(1.0), "{x} {y}");
        }
    }

    const TEXTS: [&str; 6] = [
        "the quick brown fox|jumps over the lazy dog",
        "quick quick quick|brown",
        "a slow dog sleeps|in the warm sun all day long without a care",
        "foxes and dogs|are rarely friends",
        "brown bread|",
        "the fox, the dog and the quick reply|",
    ];

    #[test]
    fn the_whole_table_as_corpus_ranks_as_bm25_does() {
        let conn = indexed(&TEXTS);
        let whole = corpus(&conn, None);
        for query in [
            "\"quick\"",
            "\"brown\" \"fox\"*",
            "\"the dog\"",
            "\"dog\" \"-\" \"the\"",
        ] {
            close(
                &ranked(&conn, query, "bm25(t)", &whole),
                &ranked(&conn, query, "bm25_within(t, ?2)", &whole),
            );
        }
    }

    #[test]
    fn a_corpus_ranks_as_bm25_over_a_table_of_only_its_entries() {
        let conn = indexed(&TEXTS);
        let kept = [1, 4, 13, 16];
        let within = corpus(&conn, Some(&kept));
        let alone = indexed(&[]);
        for (at, text) in TEXTS.iter().enumerate() {
            let rowid = at as i64 * 3 + 1;
            if kept.contains(&rowid) {
                let (a, b) = text.split_once('|').unwrap_or((text, ""));
                alone
                    .execute(
                        "INSERT INTO t (rowid, a, b) VALUES (?1, ?2, ?3)",
                        rusqlite::params![rowid, a, b],
                    )
                    .unwrap();
            }
        }
        for query in ["\"quick\"", "\"brown\" \"fox\"*", "\"the\""] {
            let mine: Vec<(i64, f64)> = ranked(&conn, query, "bm25_within(t, ?2)", &within)
                .into_iter()
                .filter(|(rowid, _)| kept.contains(rowid))
                .collect();
            close(&ranked(&alone, query, "bm25(t)", &[]), &mine);
        }
    }

    #[test]
    fn token_counts_read_every_varint_and_refuse_a_cut_one() {
        assert_eq!(tokens_of(&[3, 0, 0x81, 0x00]).unwrap(), 3 + 128);
        assert!(tokens_of(&[0x81]).is_err());
    }
}
