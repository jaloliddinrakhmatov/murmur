use super::ffi::*;
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use napi_derive::napi;

#[napi(object)]
pub struct PermissionStatus {
    /// Needed for AX focus inspection, AX insertion, and suppressing events.
    pub accessibility: bool,
    /// Needed for a listen-only CGEventTap (modifier-only shortcuts).
    pub input_monitoring: bool,
    /// Needed to post synthetic key events (Cmd+V, Unicode typing).
    pub post_events: bool,
    /// True while any app has Secure Event Input on (password fields, some terminals).
    pub secure_event_input: bool,
}

/// Reads permission state without prompting the user.
#[napi]
pub fn permission_status() -> PermissionStatus {
    unsafe {
        PermissionStatus {
            accessibility: AXIsProcessTrusted(),
            input_monitoring: CGPreflightListenEventAccess(),
            post_events: CGPreflightPostEventAccess(),
            secure_event_input: IsSecureEventInputEnabled(),
        }
    }
}

/// Shows the system Accessibility prompt. Only call from an explicit user action.
#[napi]
pub fn request_accessibility() -> bool {
    unsafe {
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
    }
}

/// Test helper: turns Secure Event Input on for this process, exactly as a focused native
/// password field does. macOS turns it off automatically when the process exits.
#[napi]
pub fn test_set_secure_event_input(enabled: bool) -> i32 {
    unsafe {
        if enabled {
            EnableSecureEventInput()
        } else {
            DisableSecureEventInput()
        }
    }
}

/// Shows the system Input Monitoring prompt. Only call from an explicit user action.
#[napi]
pub fn request_input_monitoring() -> bool {
    unsafe { CGRequestListenEventAccess() }
}
