//! Platform-independent logic for Murmur's native layer: shortcut parsing, validation,
//! conflict detection, and the hold-to-talk state machine. No FFI, fully unit-testable.

pub mod hold;
pub mod shortcut;
