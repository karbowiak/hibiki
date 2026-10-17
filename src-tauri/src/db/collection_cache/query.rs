use super::{query_order, sql, QUERY_FROM};
use rusqlite::{params, Connection};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, OnceLock},
};

// Compact identities only: full DTOs remain in SQLite. All queries share a
// 32 MiB / eight-result ceiling, including queries from departed accounts.
const MAX_BYTES: usize = 32 * 1024 * 1024;
const MAX_RESULTS: usize = 8;
#[derive(PartialEq, Eq)]
struct Key {
    database: String,
    revision: i64,
    scope: String,
    collection: String,
    generation: i64,
    filter: String,
    sort: String,
    dir: String,
}
pub(super) struct Member {
    pub kind: String,
    pub id: String,
    pub occurrence: Option<String>,
}
struct Cached {
    key: Key,
    rows: Arc<Vec<Member>>,
    bytes: usize,
}
static RESULTS: OnceLock<Mutex<VecDeque<Cached>>> = OnceLock::new();

pub(super) fn membership(
    conn: &Connection,
    scope: &str,
    collection: &str,
    generation: i64,
    filter: &str,
    sort: &str,
    dir: &str,
) -> Result<Arc<Vec<Member>>, String> {
    let order = query_order(sort, dir)?;
    let (database, revision) = sql(conn.query_row(
        "SELECT identity,revision FROM collection_query_revision WHERE singleton=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let key = Key {
        database,
        revision,
        scope: scope.into(),
        collection: collection.into(),
        generation,
        filter: filter.to_lowercase(),
        sort: sort.into(),
        dir: dir.into(),
    };
    let cache = RESULTS.get_or_init(|| Mutex::new(VecDeque::new()));
    {
        let mut results = cache
            .lock()
            .map_err(|_| "Collection query cache is unavailable")?;
        if let Some(index) = results.iter().position(|result| result.key == key) {
            let result = results.remove(index).unwrap();
            let rows = result.rows.clone();
            results.push_back(result);
            return Ok(rows);
        }
    }
    let mut statement = sql(conn.prepare(&format!(
        "SELECT m.kind,m.item_id,m.occurrence {QUERY_FROM} ORDER BY {order} LIMIT 1000001"
    )))?;
    let rows = sql(
        statement.query_map(params![scope, collection, generation, key.filter], |r| {
            Ok(Member {
                kind: r.get(0)?,
                id: r.get(1)?,
                occurrence: r.get(2)?,
            })
        }),
    )?;
    let rows = Arc::new(sql(rows.collect::<rusqlite::Result<Vec<_>>>())?);
    if rows.len() > 1_000_000 {
        return Err("This collection exceeds its saved membership limit".into());
    }
    let bytes = rows.capacity() * std::mem::size_of::<Member>()
        + rows
            .iter()
            .map(|row| {
                row.kind.len() + row.id.len() + row.occurrence.as_ref().map_or(0, String::len)
            })
            .sum::<usize>();
    if bytes <= MAX_BYTES {
        let mut results = cache
            .lock()
            .map_err(|_| "Collection query cache is unavailable")?;
        results.retain(|result| result.key != key);
        while !results.is_empty()
            && (results.len() >= MAX_RESULTS
                || results.iter().map(|result| result.bytes).sum::<usize>() + bytes > MAX_BYTES)
        {
            results.pop_front();
        }
        results.push_back(Cached {
            key,
            rows: rows.clone(),
            bytes,
        });
    }
    Ok(rows)
}
