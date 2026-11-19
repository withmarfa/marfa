//! A panic inside an exported call crosses UniFFI as an error the generated
//! Swift keeps to itself, so an app could not tell it from any other failure.
//! `guarded!` wraps each exported function that returns a `Result` so the app
//! gets `Fault` instead.

use crate::{CatchUpError, MarfaError};

/// What a caught panic says. The panic's own message is left out: it can
/// carry what the call was working on.
const FAULT_MESSAGE: &str = "the core failed while running this call";

/// An error type that can say a panic ended the call.
pub(crate) trait Faulted {
    fn faulted() -> Self;
}

impl Faulted for MarfaError {
    fn faulted() -> Self {
        MarfaError::Fault {
            message: FAULT_MESSAGE.into(),
        }
    }
}

impl Faulted for CatchUpError {
    fn faulted() -> Self {
        // The panic hid whether the catalog changed, and a copy keeps the
        // catalog a catch-up took, so the app is told to read it again.
        CatchUpError::Failed {
            error: MarfaError::faulted(),
            catalog_changed: true,
        }
    }
}

pub(crate) fn run<T, E: Faulted>(call: impl FnOnce() -> Result<T, E>) -> Result<T, E> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(call))
        .unwrap_or_else(|_| Err(E::faulted()))
}

/// Exports an impl block, written `#[uniffi::export] impl Name { ... }`, or
/// the functions written beside it, each of which returns `Result<_, E>` with
/// `E: Faulted`, so each ends a panic with `Fault`. A function that returns
/// no `Result` goes in a plain `#[uniffi::export]` block under a
/// `// unguarded:` line saying why it cannot fail; `every_export_is_guarded`
/// fails any other export.
macro_rules! guarded {
    (#[uniffi::export] impl $ty:ident { $($items:tt)* }) => {
        guarded!(@items $ty [] $($items)*);
    };
    (@items $ty:ident [$($done:tt)*]) => {
        #[uniffi::export]
        impl $ty {
            $($done)*
        }
    };
    (@items $ty:ident [$($done:tt)*]
        $(#[$meta:meta])* $vis:vis fn $name:ident ( $($args:tt)* ) -> Result<$ok:ty, $err:ty>
        $body:block
        $($rest:tt)*
    ) => {
        guarded!(@items $ty [
            $($done)*
            $(#[$meta])*
            $vis fn $name($($args)*) -> Result<$ok, $err> {
                $crate::guard::run(|| $body)
            }
        ] $($rest)*);
    };
    (@function [$($done:tt)*]
        $(#[$meta:meta])* $vis:vis fn $name:ident ( $($args:tt)* ) -> Result<$ok:ty, $err:ty>
        $body:block
        $($rest:tt)*
    ) => {
        guarded!(@function [
            $($done)*
            #[uniffi::export]
            $(#[$meta])*
            $vis fn $name($($args)*) -> Result<$ok, $err> {
                $crate::guard::run(|| $body)
            }
        ] $($rest)*);
    };
    (@function [$($done:tt)*]) => {
        $($done)*
    };
    ($($function:tt)+) => {
        guarded!(@function [] $($function)+);
    };
}

pub(crate) use guarded;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Core;

    guarded! {
        #[uniffi::export]
        impl Core {
            pub fn panic_holding_the_connection(&self) -> Result<(), MarfaError> {
                #[cfg(debug_assertions)]
                self.inner.poison_connection();
                panic!("a panic in the call")
            }

            pub fn panic_in_catch_up(&self) -> Result<crate::CatchUpReport, CatchUpError> {
                panic!("a panic in the call")
            }
        }
    }

    guarded! {
        pub fn panic_in_a_function() -> Result<(), MarfaError> {
            panic!("a panic in the call")
        }
    }

    fn core() -> (tempfile::TempDir, std::sync::Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("copy.sqlite").display().to_string();
        let core = Core::open(path, None, None, None).unwrap();
        (dir, core)
    }

    fn is_fault(error: &MarfaError) -> bool {
        matches!(error, MarfaError::Fault { .. }) && error.code() == "fault"
    }

    #[cfg(debug_assertions)]
    #[test]
    fn a_panic_in_a_method_is_a_fault_and_the_poisoned_connection_stays_one() {
        let list = |core: &Core| core.list(crate::ListFilters::default(), None);
        let (_dir, core) = core();
        assert!(list(&core).is_ok(), "the witness: the core answers first");
        let error = core.panic_holding_the_connection().unwrap_err();
        assert!(is_fault(&error), "{error:?}");
        assert_eq!(error.message(), FAULT_MESSAGE);
        for later in [list(&core).map(|_| ()), core.status().map(|_| ())] {
            let error = later.unwrap_err();
            assert!(is_fault(&error), "{error:?}");
        }
    }

    #[test]
    fn a_panic_in_a_function_is_a_fault() {
        let error = panic_in_a_function().unwrap_err();
        assert!(is_fault(&error), "{error:?}");
    }

    #[test]
    fn a_panic_in_catch_up_is_a_fault_that_says_the_catalog_may_have_changed() {
        let (_dir, core) = core();
        match core.panic_in_catch_up().unwrap_err() {
            CatchUpError::Failed {
                error,
                catalog_changed,
            } => {
                assert!(is_fault(&error), "{error:?}");
                assert!(catalog_changed);
            }
        }
    }

    #[test]
    fn a_call_that_does_not_panic_answers_as_it_did() {
        assert_eq!(run(|| Ok::<_, MarfaError>(7)), Ok(7));
        let refused = MarfaError::Invalid {
            message: "no".into(),
        };
        assert_eq!(run(|| Err::<(), _>(refused.clone())), Err(refused));
    }

    fn unguarded_exports(source: &str) -> Vec<usize> {
        let lines: Vec<&str> = source.lines().collect();
        let mut found = Vec::new();
        for (number, line) in lines.iter().enumerate() {
            let attribute = line.trim();
            if !attribute.starts_with("#[uniffi::export") || attribute.contains("with_foreign") {
                continue;
            }
            let guarded = lines[..number]
                .iter()
                .rev()
                .take_while(|above| above.trim_start().starts_with("// "))
                .any(|above| above.starts_with("// unguarded:"))
                || number
                    .checked_sub(1)
                    .is_some_and(|above| lines[above].trim() == "guarded! {");
            if !guarded {
                found.push(number + 1);
            }
        }
        found
    }

    #[test]
    fn every_export_is_guarded_or_says_why_it_need_not_be() {
        let bare = "#[uniffi::export]\nimpl Core {}\n";
        assert_eq!(
            unguarded_exports(bare),
            vec![1],
            "the witness: a bare export is found"
        );

        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut checked = 0;
        for entry in std::fs::read_dir(src).unwrap() {
            let path = entry.unwrap().path();
            if path.file_name().is_some_and(|name| name == "guard.rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            checked += source.matches("#[uniffi::export").count();
            assert_eq!(
                unguarded_exports(&source),
                Vec::<usize>::new(),
                "{} exports a function that neither guards a panic nor says why it need not",
                path.display()
            );
        }
        assert!(checked > 10, "the scan found {checked} exports");
    }
}
