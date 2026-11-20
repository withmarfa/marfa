//! The one test in this binary, because it changes the process's umask.

use std::os::unix::fs::PermissionsExt;

#[test]
fn private_folders_are_owner_only_under_a_umask_that_opens_new_folders_to_the_group() {
    // SAFETY: `umask` takes a mask and cannot fail.
    unsafe { libc::umask(0o002) };
    let root = std::env::temp_dir().join(format!("marfa-acl-umask-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let mode =
        |path: &std::path::Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    std::fs::create_dir(&root).unwrap();
    let made = std::panic::catch_unwind(|| {
        assert_eq!(
            mode(&root),
            0o775,
            "the witness: the umask opens a new folder"
        );
        let (data, update) = (root.join("data"), root.join("data/update"));
        marfa_acl::make_private_folders(&update).unwrap();
        (mode(&data), mode(&update))
    });
    let _ = std::fs::remove_dir_all(&root);
    assert_eq!(made.unwrap(), (0o700, 0o700));
}
