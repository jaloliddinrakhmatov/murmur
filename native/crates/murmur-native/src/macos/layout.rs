//! Resolves which physical key produces "v" while Command is held in a keyboard layout, so the
//! synthetic Cmd+V lands on paste in Dvorak, AZERTY, Cyrillic, etc. Needs no permission.

use super::ffi::*;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::base::CFRelease;
use core_foundation_sys::data::{CFDataGetBytePtr, CFDataRef};
use napi_derive::napi;

const ANSI_V: u16 = 9;
const ANSI_C: u16 = 8;
const CMD_MODIFIER_STATE: u32 = (1 << 8) >> 8;

#[napi(object)]
pub struct LayoutPasteKey {
    pub source_id: String,
    /// Keycode that types "v" with Command held, if the layout has one.
    pub keycode: Option<u32>,
    /// Keycode to post: `keycode`, or kVK_ANSI_V when the layout has no "v".
    pub keycode_to_post: u32,
    /// What kVK_ANSI_V types in this layout with Command held (to show why lookup matters).
    pub ansi_v_types: Option<String>,
}

unsafe fn translate(layout: *const u8, keycode: u16, modifier_state: u32) -> Option<String> {
    let mut dead = 0u32;
    let mut buf = [0u16; 4];
    let mut len = 0usize;
    let status = UCKeyTranslate(
        layout as *const _,
        keycode,
        kUCKeyActionDisplay,
        modifier_state,
        LMGetKbdType() as u32,
        kUCKeyTranslateNoDeadKeysMask,
        &mut dead,
        buf.len(),
        &mut len,
        buf.as_mut_ptr(),
    );
    (status == 0 && len > 0).then(|| String::from_utf16_lossy(&buf[..len]))
}

unsafe fn resolve(source: TISInputSourceRef) -> Option<LayoutPasteKey> {
    let id_ref = TISGetInputSourceProperty(source, kTISPropertyInputSourceID)
        as core_foundation_sys::string::CFStringRef;
    let source_id = if id_ref.is_null() {
        "unknown".to_string()
    } else {
        CFString::wrap_under_get_rule(id_ref).to_string()
    };
    let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) as CFDataRef;
    if data.is_null() {
        return None;
    }
    let layout = CFDataGetBytePtr(data);
    let keycode = (0u16..128)
        .find(|&code| translate(layout, code, CMD_MODIFIER_STATE).as_deref() == Some("v"));
    Some(LayoutPasteKey {
        source_id,
        keycode: keycode.map(u32::from),
        keycode_to_post: keycode.unwrap_or(ANSI_V) as u32,
        ansi_v_types: translate(layout, ANSI_V, CMD_MODIFIER_STATE),
    })
}

pub fn current_paste_keycode() -> u16 {
    paste_keycode().map_or(ANSI_V, |k| k.keycode_to_post as u16)
}

/// The physical key that types "c" with Command held in the current layout (kVK_ANSI_C when the
/// layout has none), so the synthetic Cmd+C lands on copy in Dvorak, AZERTY, Cyrillic, etc.
pub fn current_copy_keycode() -> u16 {
    unsafe {
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return ANSI_C;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) as CFDataRef;
        let keycode = if data.is_null() {
            None
        } else {
            let layout = CFDataGetBytePtr(data);
            (0u16..128)
                .find(|&code| translate(layout, code, CMD_MODIFIER_STATE).as_deref() == Some("c"))
        };
        CFRelease(source as _);
        keycode.unwrap_or(ANSI_C)
    }
}

#[napi]
pub fn paste_keycode() -> Option<LayoutPasteKey> {
    unsafe {
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let result = resolve(source);
        CFRelease(source as _);
        result
    }
}

/// Resolves the paste key for every keyboard layout installed on this Mac (not just enabled ones).
#[napi]
pub fn paste_keycodes_for_installed_layouts() -> Vec<LayoutPasteKey> {
    unsafe {
        let filter = CFDictionary::from_CFType_pairs(&[(
            CFString::wrap_under_get_rule(kTISPropertyInputSourceType),
            CFString::wrap_under_get_rule(kTISTypeKeyboardLayout).as_CFType(),
        )]);
        let list = TISCreateInputSourceList(filter.as_concrete_TypeRef(), true);
        if list.is_null() {
            return Vec::new();
        }
        let sources: CFArray<CFType> = CFArray::wrap_under_create_rule(list);
        sources
            .iter()
            .filter_map(|s| resolve(s.as_CFTypeRef() as TISInputSourceRef))
            .collect()
    }
}
