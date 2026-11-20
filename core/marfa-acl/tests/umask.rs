//! The one test in this binary, because it changes the process's umask.

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn mode(path: &Path) -> u32 {
    std::fs::metadata(path).unwrap().permissions().mode() & 0o777
}

fn made_under(mask: libc::mode_t) {
    // SAFETY: `umask` takes a mask and cannot fail.
    unsafe { libc::umask(mask) };
    let root =
        std::env::temp_dir().join(format!("marfa-acl-umask-{}-{mask:o}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir(&root).unwrap();
    let made = std::panic::catch_unwind(|| {
        let (data, update) = (root.join("data"), root.join("data/update"));
        marfa_acl::make_private_folders(&update).unwrap();
        let (srv, install) = (root.join("srv"), root.join("srv/marfa"));
        marfa_acl::make_private_folder_in_open_folders(&install).unwrap();
        let (above, open) = (root.join("above"), root.join("above/open"));
        marfa_acl::make_open_folders(&open).unwrap();
        [&data, &update, &srv, &install, &above, &open].map(|path| mode(path))
    });
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(
        made.unwrap(),
        [0o700, 0o700, 0o755, 0o700, 0o755, 0o755],
        "under umask {mask:o}"
    );
}

#[test]
fn folders_get_the_modes_asked_for_under_any_umask() {
    // SAFETY: `umask` takes a mask and cannot fail.
    unsafe { libc::umask(0o002) };
    let witness = std::env::temp_dir().join(format!("marfa-acl-witness-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&witness);
    std::fs::create_dir(&witness).unwrap();
    let opened = mode(&witness);
    let _ = std::fs::remove_dir_all(&witness);
    assert_eq!(opened, 0o775, "the witness: the umask opens a new folder");
    for mask in [0o000, 0o002, 0o022, 0o077] {
        made_under(mask);
    }
}
