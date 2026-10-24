//! Insertion strategy chain from docs/ARCHITECTURE.md §5, reduced to the M0 subset:
//!   secure checks → Accessibility direct insert (verified) → clipboard + Cmd+V → clipboard only.
//!
//! Clipboard restore is left to the caller (it schedules `clipboard_restore` after a per-app
//! delay) so this call never blocks the Electron main thread for the restore window.

use super::clipboard::{
    clipboard_change_count, clipboard_discard_snapshot, clipboard_restore, clipboard_snapshot, pasteboard_has_sensitive_type,
    read_plain_text, write_text,
};
use super::ffi::*;
use super::layout::{current_copy_keycode, current_paste_keycode};
use super::target::{ax_error_name, describe, focused_element_ref, frontmost_app, AppInfo, FocusInfo};
use crate::now_ms;
use napi_derive::napi;
use std::time::Duration;

#[napi(object)]
pub struct InsertOptions {
    pub allow_accessibility: Option<bool>,
    pub allow_paste: Option<bool>,
    /// Max time to wait for the user to release modifier keys before posting Cmd+V.
    pub modifier_wait_ms: Option<u32>,
}

#[napi(object)]
pub struct InsertResult {
    /// "accessibility" | "clipboard-paste" | "clipboard-only" | "rejected"
    pub strategy: String,
    /// True when text was delivered to the target or placed on the clipboard as a fallback.
    pub ok: bool,
    /// True only when we read the field back and saw the text.
    pub verified: bool,
    pub reason: Option<String>,
    pub app: Option<AppInfo>,
    pub focus: Option<FocusInfo>,
    /// Snapshot to restore (clipboard-paste only) and the changeCount right after our write.
    pub snapshot_id: Option<u32>,
    pub change_count_after_write: Option<f64>,
    pub elapsed_ms: f64,
    pub steps: Vec<String>,
}

const USER_MODIFIERS: CGEventFlags =
    kCGEventFlagMaskShift | kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskCommand;

fn wait_for_modifier_release(max_ms: u32) -> bool {
    let deadline = now_ms() + max_ms as f64;
    loop {
        let flags = unsafe { CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) };
        if flags & USER_MODIFIERS == 0 {
            return true;
        }
        if now_ms() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// Posts a key press (down, then up) with `flags`. False, with nothing posted, when macOS can't
/// create the events: a lone key-down must never be left without its key-up.
fn post_key(keycode: u16, flags: CGEventFlags) -> bool {
    unsafe {
        let source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
        let down = CGEventCreateKeyboardEvent(source, keycode, true);
        let up = CGEventCreateKeyboardEvent(source, keycode, false);
        let posted = !down.is_null() && !up.is_null();
        if posted {
            for event in [down, up] {
                CGEventSetFlags(event, flags);
                CGEventPost(kCGHIDEventTap, event);
            }
        }
        for object in [down as *const std::ffi::c_void, up as _, source as _] {
            if !object.is_null() {
                core_foundation_sys::base::CFRelease(object as _);
            }
        }
        posted
    }
}

fn post_cmd_v() -> bool {
    post_key(current_paste_keycode(), kCGEventFlagMaskCommand)
}

#[napi]
pub fn insert_text(text: String, options: Option<InsertOptions>) -> InsertResult {
    let started = now_ms();
    let allow_ax = options.as_ref().and_then(|o| o.allow_accessibility).unwrap_or(true);
    let allow_paste = options.as_ref().and_then(|o| o.allow_paste).unwrap_or(true);
    let modifier_wait = options.as_ref().and_then(|o| o.modifier_wait_ms).unwrap_or(600);
    let mut steps = Vec::new();
    let app = frontmost_app();

    let result = |strategy: &str, ok, verified, reason: Option<&str>, focus, snapshot_id, cc, steps| {
        InsertResult {
            strategy: strategy.into(),
            ok,
            verified,
            reason: reason.map(String::from),
            app: app.clone(),
            focus,
            snapshot_id,
            change_count_after_write: cc,
            elapsed_ms: now_ms() - started,
            steps,
        }
    };

    // 1. Secure Event Input is on whenever a native password field has focus. It is the only
    //    password signal available without Accessibility, so it is checked first.
    if unsafe { IsSecureEventInputEnabled() } {
        steps.push("secure-event-input:on".into());
        return result("rejected", false, false, Some("secure-event-input"), None, None, None, steps);
    }

    // 2. Inspect the focused element when Accessibility is granted.
    let focused = focused_element_ref();
    let focus_info = match &focused {
        Ok(el) => Some(describe(el, allow_ax)),
        Err(err) => {
            steps.push(format!("focus:{}", ax_error_name(*err)));
            None
        }
    };
    if let Some(info) = &focus_info {
        steps.push(format!(
            "focus:{}/{}",
            info.role.as_deref().unwrap_or("?"),
            info.subrole.as_deref().unwrap_or("-")
        ));
        if info.is_secure {
            return result("rejected", false, false, Some("secure-text-field"), focus_info, None, None, steps);
        }
    }

    // 3. Accessibility direct insert, accepted only when the value can be read back.
    if let (true, Ok(el), Some(info)) = (allow_ax, &focused, &focus_info) {
        if info.selected_text_settable {
            let before = el.string_attr("AXValue");
            let err = el.set_string("AXSelectedText", &text);
            let after = el.string_attr("AXValue");
            steps.push(format!("ax-set:{err}"));
            let verified = err == kAXErrorSuccess
                && after.as_deref().is_some_and(|a| a.contains(text.as_str()))
                && after != before;
            if verified {
                return result("accessibility", true, true, None, focus_info, None, None, steps);
            }
            let definitely_unchanged = before.is_some() && after == before;
            if err == kAXErrorSuccess && !definitely_unchanged {
                // The app accepted the write but we cannot prove where the text went. Falling
                // through could insert it twice, so stop here and report it as unverified.
                return result(
                    "accessibility",
                    true,
                    false,
                    Some("unverifiable"),
                    focus_info,
                    None,
                    None,
                    steps,
                );
            }
            steps.push("ax-no-effect:fallback".into());
        } else {
            steps.push("ax:selected-text-not-settable".into());
        }
    }

    // 4. Clipboard + synthetic Cmd+V.
    let snapshot_id = clipboard_snapshot();
    let Some(change_count) = write_text(&text, true) else {
        // Nothing of ours was written; the clipboard still holds what the person had.
        super::clipboard::clipboard_discard_snapshot(snapshot_id);
        steps.push("clipboard-write-failed".into());
        return result("rejected", false, false, Some("clipboard-write-failed"), focus_info, None, None, steps);
    };
    let can_post = unsafe { CGPreflightPostEventAccess() };
    if allow_paste && can_post {
        if !wait_for_modifier_release(modifier_wait) {
            steps.push("modifiers-still-held".into());
        }
        if !post_cmd_v() {
            // The text is on the clipboard for a manual paste; the person needs it, so no restore.
            super::clipboard::clipboard_discard_snapshot(snapshot_id);
            steps.push("cmd-v-event-failed".into());
            return result(
                "clipboard-only",
                true,
                false,
                Some("paste-failed"),
                focus_info,
                None,
                Some(change_count),
                steps,
            );
        }
        steps.push(format!("posted-cmd-v:keycode={}", current_paste_keycode()));
        return result(
            "clipboard-paste",
            true,
            false,
            None,
            focus_info,
            Some(snapshot_id),
            Some(change_count),
            steps,
        );
    }

    // 5. Leave the text on the clipboard for a manual paste. No restore: the user needs it.
    super::clipboard::clipboard_discard_snapshot(snapshot_id);
    let reason = if allow_paste { "no-post-event-permission" } else { "paste-disabled" };
    result("clipboard-only", true, false, Some(reason), focus_info, None, Some(change_count), steps)
}

#[napi(object)]
pub struct PressResult {
    pub ok: bool,
    /// "no-post-event-permission" when macOS doesn't let Murmur post keys.
    pub reason: Option<String>,
    pub steps: Vec<String>,
}

/// Presses Return in the frontmost app (Stage E, “Press Enter”). Waits for the shortcut's
/// modifier keys to be released first, so the app sees a plain Return, not ⌃⌥Return.
/// Refuses ("target-changed") unless the frontmost app is `expected_pid`, checked again after the
/// wait, and ("secure-input") while macOS secure event input is on (a password field has focus).
#[napi]
pub fn press_return(modifier_wait_ms: Option<u32>, expected_pid: i32) -> PressResult {
    let mut steps = Vec::new();
    let refuse = |reason: &str, steps: Vec<String>| PressResult {
        ok: false,
        reason: Some(reason.into()),
        steps,
    };
    let guard = || -> Option<&'static str> {
        if frontmost_app().map(|a| a.pid) != Some(expected_pid) {
            Some("target-changed")
        } else if unsafe { IsSecureEventInputEnabled() } {
            Some("secure-input")
        } else {
            None
        }
    };
    if let Some(reason) = guard() {
        return refuse(reason, steps);
    }
    if !unsafe { CGPreflightPostEventAccess() } {
        return PressResult {
            ok: false,
            reason: Some("no-post-event-permission".into()),
            steps,
        };
    }
    if !wait_for_modifier_release(modifier_wait_ms.unwrap_or(600)) {
        steps.push("modifiers-still-held".into());
    }
    if let Some(reason) = guard() {
        return refuse(reason, steps);
    }
    const RETURN_KEYCODE: u16 = 36;
    if !post_key(RETURN_KEYCODE, 0) {
        return refuse("event-failed", steps);
    }
    steps.push("posted-return".into());
    PressResult { ok: true, reason: None, steps }
}

#[napi(object)]
pub struct CopySelectionResult {
    pub ok: bool,
    pub text: Option<String>,
    /// "target-changed" | "secure-input" | "secure-text-field" | "no-post-event-permission" |
    /// "event-failed" | "nothing-copied" | "sensitive" | "too-long"
    pub reason: Option<String>,
}

/// Longest selection returned (the app's TRANSFORM_TEXT_MAX); longer ones report "too-long".
const COPY_TEXT_MAX_CHARS: usize = 24_000;

/// Reads the selection of the frontmost app by copying it (Cmd+C), for apps that don't expose it
/// through Accessibility. Waits for the shortcut's modifier keys to be released; refuses unless the
/// frontmost app is `expected_pid` (checked before and right before posting), while secure event
/// input is on, or when the focused field is a password field. The clipboard is restored after the
/// text is read, and left untouched when nothing was copied. A concealed/transient copy is never read.
#[napi]
pub fn copy_selection(expected_pid: i32, modifier_wait_ms: Option<u32>, timeout_ms: Option<u32>) -> CopySelectionResult {
    let refuse = |reason: &str| CopySelectionResult {
        ok: false,
        text: None,
        reason: Some(reason.into()),
    };
    let guard = || -> Option<&'static str> {
        if frontmost_app().map(|a| a.pid) != Some(expected_pid) {
            Some("target-changed")
        } else if unsafe { IsSecureEventInputEnabled() } {
            Some("secure-input")
        } else if focused_element_ref().is_ok_and(|el| describe(&el, false).is_secure) {
            Some("secure-text-field")
        } else {
            None
        }
    };
    if let Some(reason) = guard() {
        return refuse(reason);
    }
    if !unsafe { CGPreflightPostEventAccess() } {
        return refuse("no-post-event-permission");
    }
    wait_for_modifier_release(modifier_wait_ms.unwrap_or(600));
    // Still held: Cmd+C would arrive with the shortcut's other modifiers added.
    let flags = unsafe { CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState) };
    if flags & USER_MODIFIERS != 0 {
        return refuse("modifiers-still-held");
    }
    if let Some(reason) = guard() {
        return refuse(reason);
    }

    let snapshot_id = clipboard_snapshot();
    let before = clipboard_change_count();
    if !post_key(current_copy_keycode(), kCGEventFlagMaskCommand) {
        clipboard_discard_snapshot(snapshot_id);
        return refuse("event-failed");
    }
    let deadline = now_ms() + timeout_ms.unwrap_or(400) as f64;
    let mut changed = false;
    while now_ms() < deadline {
        if clipboard_change_count() != before {
            changed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !changed {
        clipboard_discard_snapshot(snapshot_id);
        return refuse("nothing-copied");
    }
    // Give the app a moment to finish writing all its types before reading and restoring.
    std::thread::sleep(Duration::from_millis(30));
    let after = clipboard_change_count();
    let sensitive = pasteboard_has_sensitive_type();
    let text = if sensitive { None } else { read_plain_text() };
    clipboard_restore(snapshot_id, after);
    if sensitive {
        return refuse("sensitive");
    }
    match text {
        None => refuse("nothing-copied"),
        Some(t) if t.chars().count() > COPY_TEXT_MAX_CHARS => refuse("too-long"),
        Some(t) => CopySelectionResult {
            ok: true,
            text: Some(t),
            reason: None,
        },
    }
}
