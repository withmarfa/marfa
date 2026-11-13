use std::ffi::{CStr, c_void};

#[global_allocator]
static ALLOCATOR: marfa_allocator::Allocator = marfa_allocator::Allocator;

fn read<T: Default>(name: &CStr) -> T {
    let mut value = T::default();
    let mut length = size_of::<T>();
    // SAFETY: `value` is as long as `length` says.
    let status = unsafe {
        tikv_jemalloc_sys::mallctl(
            name.as_ptr(),
            (&raw mut value).cast::<c_void>(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    assert_eq!(status, 0, "{name:?}");
    value
}

/// Bytes this thread has asked the allocator for, ever.
pub fn requested() -> u64 {
    read::<u64>(c"thread.allocated")
}

#[allow(dead_code)]
pub fn dirty_decay_ms() -> i64 {
    read::<i64>(c"opt.dirty_decay_ms")
}

#[allow(dead_code)]
pub fn arenas() -> u32 {
    read::<u32>(c"opt.narenas")
}

#[allow(dead_code)]
pub fn setting(name: &CStr) -> bool {
    read::<bool>(name)
}

/// What a page cache of a table of 100,000 rows takes, as the allocator sees it.
pub fn sqlite_requests() -> u64 {
    let before = requested();
    let connection = rusqlite::Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "create table t(a integer primary key, b text);
             with recursive c(x) as (select 1 union all select x + 1 from c where x < 100000)
             insert into t select x, 'row ' || x from c;
             select count(*) from t;",
        )
        .unwrap();
    requested() - before
}
