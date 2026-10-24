// Apple constant names (kAXError…, kCGEvent…) are kept verbatim for greppability.
#![allow(non_upper_case_globals)]

pub mod calendar;
pub mod carbon;
pub mod clipboard;
pub mod ffi;
pub mod insert;
pub mod layout;
pub mod permissions;
pub mod sysaudio;
#[cfg(feature = "key-tap")]
pub mod tap;
pub mod target;
