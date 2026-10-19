//! Compile-fail coverage for the public spawn API's evolution boundaries.
//!
//! Downstream callers configure [`super::SpawnOptions`] from its default instead
//! of an exhaustive struct literal, so future optional inputs remain additive.
//!
//! ```compile_fail,E0639
//! use muse_code_sdk::spawn::SpawnOptions;
//!
//! let _ = SpawnOptions {
//!     ..SpawnOptions::default()
//! };
//! ```
//!
//! ```no_run
//! use std::path::PathBuf;
//!
//! use muse_code_sdk::spawn::SpawnOptions;
//!
//! let mut options = SpawnOptions::default();
//! options.muse_bin = Some(PathBuf::from("/path/to/muse"));
//! ```
//!
//! Downstream code cannot build [`super::ExitClassification`] with a struct
//! literal and must match it with `..`, so later evidence fields stay additive.
//!
//! ```compile_fail,E0639
//! use muse_code_sdk::spawn::ExitClassification;
//!
//! fn rebuild(classification: ExitClassification) {
//!     let _ = ExitClassification {
//!         ..classification
//!     };
//! }
//! ```
//!
//! ```no_run
//! use muse_code_sdk::spawn::ExitClassification;
//!
//! fn inspect(classification: ExitClassification) {
//!     let ExitClassification { kind, .. } = classification;
//!     println!("{kind:?}");
//! }
//! ```
//!
//! Downstream matches on [`super::SpawnError::Launch`] include `..`, so later
//! launch evidence can be added without breaking exhaustive destructuring.
//!
//! ```compile_fail,E0638
//! use muse_code_sdk::spawn::SpawnError;
//!
//! fn inspect(error: SpawnError) {
//!     match error {
//!         SpawnError::Discovery(_) => {}
//!         SpawnError::Launch {
//!             binary: _,
//!             source: _,
//!         } => {}
//!     }
//! }
//! ```
//!
//! Callers inspect only the launch-failure fields they need, and match
//! `SpawnError` itself with a catch-all arm, since it is `#[non_exhaustive]`.
//!
//! ```
//! use std::path::Path;
//!
//! use muse_code_sdk::spawn::SpawnError;
//!
//! fn binary(error: &SpawnError) -> Option<&Path> {
//!     match error {
//!         SpawnError::Discovery(_) => None,
//!         SpawnError::Launch { binary, .. } => Some(binary.as_path()),
//!         _ => None,
//!     }
//! }
//! ```
//!
//! Launch failures are created only by SDK-owned spawn paths, so downstream
//! callers cannot freeze an external constructor signature.
//!
//! ```compile_fail,E0599
//! use std::io;
//!
//! use muse_code_sdk::spawn::SpawnError;
//!
//! let _ = SpawnError::launch("muse", io::Error::other("not executable"));
//! ```
