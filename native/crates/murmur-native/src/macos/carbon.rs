//! Global hotkeys via Carbon `RegisterEventHotKey`.
//!
//! Requires no TCC permission and reports both press and release, which is enough for
//! hold-to-talk on modifier+key combos. Events are dispatched by the main-thread event loop,
//! so they are delivered inside Electron's main process but not in a plain Node process.

use super::ffi::*;
use crate::now_ms;
use murmur_core::shortcut::{validate, Action, Backend, Shortcut};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;
use std::sync::{Mutex, Once};

const SIGNATURE: u32 = fourcc(b"MRMR");
/// `eventNotHandledErr`: the event goes on to other handlers.
const EVENT_NOT_HANDLED: OSStatus = -9874;

#[napi(object)]
#[derive(Clone)]
pub struct HotkeyEvent {
    pub id: u32,
    /// "pressed" | "released"
    pub kind: String,
    pub t_ms: f64,
}

pub type HotkeyCallback = ThreadsafeFunction<HotkeyEvent, (), HotkeyEvent, Status, false>;

struct Registration {
    hotkey: usize,
    callback: HotkeyCallback,
}

static REGISTRY: Mutex<Option<HashMap<u32, Registration>>> = Mutex::new(None);
static HANDLER: Once = Once::new();
static mut HANDLER_STATUS: OSStatus = 0;

extern "C" fn on_hotkey(_next: EventHandlerCallRef, event: EventRef, _user: *mut c_void) -> OSStatus {
    let mut hk = EventHotKeyID::default();
    let status = unsafe {
        GetEventParameter(
            event,
            kEventParamDirectObject,
            typeEventHotKeyID,
            ptr::null_mut(),
            std::mem::size_of::<EventHotKeyID>(),
            ptr::null_mut(),
            &mut hk as *mut _ as *mut c_void,
        )
    };
    if status != 0 {
        return status;
    }
    if hk.signature != SIGNATURE {
        // Not one of ours: let the next handler in the chain have it.
        return EVENT_NOT_HANDLED;
    }
    let kind = match unsafe { GetEventKind(event) } {
        kEventHotKeyPressed => "pressed",
        kEventHotKeyReleased => "released",
        _ => return 0,
    };
    let t_ms = now_ms();
    if let Some(map) = REGISTRY.lock().unwrap().as_ref() {
        if let Some(reg) = map.get(&hk.id) {
            reg.callback.call(
                HotkeyEvent {
                    id: hk.id,
                    kind: kind.to_string(),
                    t_ms,
                },
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    }
    0
}

#[napi(object)]
pub struct RegisterOptions {
    /// Ask macOS to refuse the hotkey to other apps (`kEventHotKeyExclusive`).
    pub exclusive: Option<bool>,
    /// Skip Murmur's validation rules, to measure raw macOS behavior in tests.
    pub skip_validation: Option<bool>,
    /// "pushToTalk" (default) | "handsFree" | "cancel" | "pasteLast": which rules apply.
    pub action: Option<String>,
}

#[napi(object)]
pub struct RegisterResult {
    pub ok: bool,
    /// Raw OSStatus from RegisterEventHotKey (0 = noErr, -9878 = already taken exclusively).
    pub status: i32,
    pub error: Option<String>,
    pub normalized: Option<String>,
}

fn fail(error: impl Into<String>, status: i32) -> RegisterResult {
    RegisterResult {
        ok: false,
        status,
        error: Some(error.into()),
        normalized: None,
    }
}

#[napi]
pub fn register_hotkey(
    id: u32,
    shortcut: String,
    options: Option<RegisterOptions>,
    callback: HotkeyCallback,
) -> RegisterResult {
    let parsed = match Shortcut::parse(&shortcut) {
        Ok(s) => s,
        Err(e) => return fail(e.to_string(), 0),
    };
    let Some(key) = parsed.key.filter(|_| !parsed.is_modifier_only()) else {
        return fail("needs-event-tap", 0);
    };
    let skip_validation = options.as_ref().and_then(|o| o.skip_validation).unwrap_or(false);
    let action = match options.as_ref().and_then(|o| o.action.as_deref()) {
        None => Action::PushToTalk,
        Some(name) => match Action::parse(name) {
            Some(a) => a,
            None => return fail(format!("unknown action {name}"), 0),
        },
    };
    if !skip_validation {
        let v = validate(&parsed, action);
        if let Some(e) = v.errors.first() {
            return fail(*e, 0);
        }
        if v.backend != Backend::Carbon {
            return fail("needs-event-tap", 0);
        }
    }

    let mut registry = REGISTRY.lock().unwrap();
    let map = registry.get_or_insert_with(HashMap::new);
    if map.contains_key(&id) {
        return fail("id-already-registered", 0);
    }

    HANDLER.call_once(|| {
        let specs = [
            EventTypeSpec {
                event_class: kEventClassKeyboard,
                event_kind: kEventHotKeyPressed,
            },
            EventTypeSpec {
                event_class: kEventClassKeyboard,
                event_kind: kEventHotKeyReleased,
            },
        ];
        unsafe {
            HANDLER_STATUS = InstallEventHandler(
                GetApplicationEventTarget(),
                on_hotkey,
                specs.len() as u32,
                specs.as_ptr(),
                ptr::null_mut(),
                ptr::null_mut(),
            );
        }
    });
    let handler_status = unsafe { HANDLER_STATUS };
    if handler_status != 0 {
        return fail("InstallEventHandler failed", handler_status);
    }

    let exclusive = options.as_ref().and_then(|o| o.exclusive).unwrap_or(false);
    let mut hotkey: EventHotKeyRef = ptr::null_mut();
    let status = unsafe {
        RegisterEventHotKey(
            key.keycode as u32,
            parsed.mods.carbon_mask(),
            EventHotKeyID {
                signature: SIGNATURE,
                id,
            },
            GetApplicationEventTarget(),
            if exclusive {
                kEventHotKeyExclusive
            } else {
                kEventHotKeyNoOptions
            },
            &mut hotkey,
        )
    };
    if status != 0 {
        let msg = match status {
            eventHotKeyExistsErr => "taken-by-another-registration",
            eventHotKeyInvalidErr => "invalid-hotkey",
            _ => "register-failed",
        };
        return fail(msg, status);
    }
    map.insert(
        id,
        Registration {
            hotkey: hotkey as usize,
            callback,
        },
    );
    RegisterResult {
        ok: true,
        status,
        error: None,
        normalized: Some(parsed.to_string()),
    }
}

#[napi]
pub fn unregister_hotkey(id: u32) -> i32 {
    let mut registry = REGISTRY.lock().unwrap();
    let Some(reg) = registry.as_mut().and_then(|m| m.remove(&id)) else {
        return -1;
    };
    unsafe { UnregisterEventHotKey(reg.hotkey as EventHotKeyRef) }
}

#[napi]
pub fn registered_hotkey_count() -> u32 {
    REGISTRY
        .lock()
        .unwrap()
        .as_ref()
        .map_or(0, |m| m.len() as u32)
}
