use std::ffi::{c_int, c_void};

pub use tikv_jemallocator::Jemalloc as Allocator;

/// Decay is 0 because jemalloc has no background thread on macOS to purge later.
#[unsafe(export_name = "_rjem_malloc_conf")]
static MALLOC_CONF: &[u8; 57] = b"narenas:2,dirty_decay_ms:0,muzzy_decay_ms:0,tcache:false\0";

unsafe extern "C" fn allocate(size: c_int) -> *mut c_void {
    unsafe { tikv_jemalloc_sys::malloc(size as usize) }
}

unsafe extern "C" fn release(block: *mut c_void) {
    unsafe { tikv_jemalloc_sys::free(block) }
}

unsafe extern "C" fn reallocate(block: *mut c_void, size: c_int) -> *mut c_void {
    unsafe { tikv_jemalloc_sys::realloc(block, size as usize) }
}

unsafe extern "C" fn size_of(block: *mut c_void) -> c_int {
    unsafe { tikv_jemalloc_sys::malloc_usable_size(block) as c_int }
}

unsafe extern "C" fn round_up(size: c_int) -> c_int {
    unsafe { tikv_jemalloc_sys::nallocx(size as usize, 0) as c_int }
}

unsafe extern "C" fn start(_: *mut c_void) -> c_int {
    0
}

unsafe extern "C" fn stop(_: *mut c_void) {}

/// Call it first in `main`: SQLite takes the setting only before it first runs.
pub fn route_sqlite() {
    let mut methods = rusqlite::ffi::sqlite3_mem_methods {
        xMalloc: Some(allocate),
        xFree: Some(release),
        xRealloc: Some(reallocate),
        xSize: Some(size_of),
        xRoundup: Some(round_up),
        xInit: Some(start),
        xShutdown: Some(stop),
        pAppData: std::ptr::null_mut(),
    };
    // SAFETY: SQLite copies the methods, and the functions above are the whole of what it asks for.
    let status = unsafe {
        rusqlite::ffi::sqlite3_config(rusqlite::ffi::SQLITE_CONFIG_MALLOC, &raw mut methods)
    };
    assert_eq!(
        status,
        rusqlite::ffi::SQLITE_OK,
        "SQLite had already started"
    );
}
