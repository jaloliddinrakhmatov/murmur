//! Focused-target detection: frontmost app (no permission) and focused element (Accessibility).

use super::ffi::*;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFGetTypeID, CFRelease, CFTypeRef};
use napi_derive::napi;
use objc2_app_kit::NSRunningApplication;
use std::ptr;

#[napi(object)]
#[derive(Clone)]
pub struct AppInfo {
    pub pid: i32,
    pub name: Option<String>,
    pub bundle_id: Option<String>,
}

fn bundle_id_for(pid: i32) -> Option<String> {
    let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
    app.bundleIdentifier().map(|s| s.to_string())
}

/// Frontmost application per AppKit (`NSWorkspace.frontmostApplication`). No permission needed.
#[napi]
pub fn frontmost_app() -> Option<AppInfo> {
    objc2::rc::autoreleasepool(|_| {
        let app = objc2_app_kit::NSWorkspace::sharedWorkspace().frontmostApplication()?;
        Some(AppInfo {
            pid: app.processIdentifier(),
            name: app.localizedName().map(|s| s.to_string()),
            bundle_id: app.bundleIdentifier().map(|s| s.to_string()),
        })
    })
}

/// Owner of the topmost normal (layer 0) on-screen window. Kept for comparison only: M0 measured
/// it reporting Chrome while TextEdit was frontmost, because the active app need not own the
/// topmost layer-0 window (e.g. an app that is launching or showing only a panel).
#[napi]
pub fn frontmost_app_by_window_list() -> Option<AppInfo> {
    objc2::rc::autoreleasepool(|_| unsafe {
        let raw = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            0,
        );
        if raw.is_null() {
            return None;
        }
        let windows: CFArray<CFDictionary<CFString, CFType>> = CFArray::wrap_under_create_rule(raw);
        let layer_key = CFString::wrap_under_get_rule(kCGWindowLayer);
        let pid_key = CFString::wrap_under_get_rule(kCGWindowOwnerPID);
        let name_key = CFString::wrap_under_get_rule(kCGWindowOwnerName);
        for window in windows.iter() {
            let number = |key: &CFString| {
                window
                    .find(key)
                    .and_then(|v| v.downcast::<CFNumber>())
                    .and_then(|n| n.to_i64())
            };
            if number(&layer_key) != Some(0) {
                continue;
            }
            let Some(pid) = number(&pid_key) else { continue };
            let pid = pid as i32;
            let name = window
                .find(&name_key)
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string());
            return Some(AppInfo {
                pid,
                name,
                bundle_id: bundle_id_for(pid),
            });
        }
        None
    })
}

pub struct Element(pub AXUIElementRef);

impl Drop for Element {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) };
        }
    }
}

impl Element {
    pub fn copy_attr(&self, name: &str) -> Result<CFType, AXError> {
        let attr = CFString::new(name);
        let mut value: CFTypeRef = ptr::null();
        let err =
            unsafe { AXUIElementCopyAttributeValue(self.0, attr.as_concrete_TypeRef(), &mut value) };
        if err != kAXErrorSuccess {
            return Err(err);
        }
        if value.is_null() {
            return Err(kAXErrorNoValue);
        }
        Ok(unsafe { CFType::wrap_under_create_rule(value) })
    }

    pub fn string_attr(&self, name: &str) -> Option<String> {
        self.copy_attr(name)
            .ok()?
            .downcast::<CFString>()
            .map(|s| s.to_string())
    }

    pub fn is_settable(&self, name: &str) -> bool {
        let attr = CFString::new(name);
        let mut settable = 0u8;
        let err = unsafe {
            AXUIElementIsAttributeSettable(self.0, attr.as_concrete_TypeRef(), &mut settable)
        };
        err == kAXErrorSuccess && settable != 0
    }

    pub fn set_string(&self, name: &str, value: &str) -> AXError {
        let attr = CFString::new(name);
        let value = CFString::new(value);
        unsafe {
            AXUIElementSetAttributeValue(
                self.0,
                attr.as_concrete_TypeRef(),
                value.as_CFTypeRef(),
            )
        }
    }

    pub fn pid(&self) -> Option<i32> {
        let mut pid = 0;
        (unsafe { AXUIElementGetPid(self.0, &mut pid) } == kAXErrorSuccess).then_some(pid)
    }
}

pub fn focused_element_ref() -> Result<Element, AXError> {
    let system = Element(unsafe { AXUIElementCreateSystemWide() });
    // Bound how long a hung target app can block us.
    unsafe { AXUIElementSetMessagingTimeout(system.0, 0.25) };
    let focused = system.copy_attr("AXFocusedUIElement")?;
    // Retain for our own Element wrapper; `focused` releases its reference on drop.
    let raw = focused.as_CFTypeRef();
    unsafe { core_foundation_sys::base::CFRetain(raw) };
    Ok(Element(raw as AXUIElementRef))
}

#[napi(object)]
pub struct FocusInfo {
    pub ok: bool,
    /// "accessibility-not-trusted" | "no-focused-element" | "ax-error:<code>"
    pub error: Option<String>,
    pub pid: Option<i32>,
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub is_secure: bool,
    pub value_readable: bool,
    pub selected_text_settable: bool,
}

pub fn ax_error_name(err: AXError) -> String {
    match err {
        kAXErrorAPIDisabled => "accessibility-not-trusted".into(),
        kAXErrorNoValue => "no-focused-element".into(),
        other => format!("ax-error:{other}"),
    }
}

pub fn is_secure(role: Option<&str>, subrole: Option<&str>) -> bool {
    subrole == Some("AXSecureTextField") || role == Some("AXSecureTextField")
}

/// `read_value`: whether to test that the field's value can be read. That copies the whole
/// field (a document, possibly), so the paste path, which doesn't need it, passes false.
pub fn describe(el: &Element, read_value: bool) -> FocusInfo {
    let role = el.string_attr("AXRole");
    let subrole = el.string_attr("AXSubrole");
    FocusInfo {
        ok: true,
        error: None,
        pid: el.pid(),
        is_secure: is_secure(role.as_deref(), subrole.as_deref()),
        value_readable: read_value && el.string_attr("AXValue").is_some(),
        selected_text_settable: el.is_settable("AXSelectedText"),
        role,
        subrole,
    }
}

#[napi]
pub fn focused_element() -> FocusInfo {
    match focused_element_ref() {
        Ok(el) => describe(&el, true),
        Err(err) => FocusInfo {
            ok: false,
            error: Some(ax_error_name(err)),
            pid: None,
            role: None,
            subrole: None,
            is_secure: false,
            value_readable: false,
            selected_text_settable: false,
        },
    }
}

/// The focused element's selection, for Transforms (Stage 9C). Reads only `AXSelectedText` and
/// `AXSelectedTextRange` (never the field's whole value), and nothing at all from a secure
/// (password) field.
#[napi(object)]
pub struct SelectionInfo {
    pub ok: bool,
    /// "accessibility-not-trusted" | "no-focused-element" | "ax-error:<code>"
    pub error: Option<String>,
    pub pid: Option<i32>,
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub is_secure: bool,
    /// The selected text; None when the app doesn't expose it, or for a secure field.
    pub text: Option<String>,
    /// UTF-16 offsets, when the app exposes the selected range.
    pub range_location: Option<f64>,
    pub range_length: Option<f64>,
    /// Whether the app lets the selection be changed (false for terminals' output, read-only
    /// views, PDFs): Replace is offered only when true.
    pub editable: bool,
    /// Identifies the field (role, subrole, identifier, window title), to check at Replace time
    /// that it is still the same one. Not its content.
    pub element_key: Option<String>,
}

fn element_key(el: &Element, role: Option<&str>, subrole: Option<&str>) -> String {
    let window_title = el
        .copy_attr("AXWindow")
        .ok()
        .and_then(|w| {
            let raw = w.as_CFTypeRef();
            unsafe { core_foundation_sys::base::CFRetain(raw) };
            Element(raw as AXUIElementRef).string_attr("AXTitle")
        })
        .unwrap_or_default();
    format!(
        "{}|{}|{}|{}",
        role.unwrap_or(""),
        subrole.unwrap_or(""),
        el.string_attr("AXIdentifier").unwrap_or_default(),
        window_title
    )
}

fn selected_range(el: &Element) -> Option<(f64, f64)> {
    let value = el.copy_attr("AXSelectedTextRange").ok()?;
    // Only an AXValue can be decoded as a range; some apps return other types.
    if unsafe { CFGetTypeID(value.as_CFTypeRef()) != AXValueGetTypeID() } {
        return None;
    }
    let mut range = core_foundation_sys::base::CFRange {
        location: 0,
        length: 0,
    };
    let ok = unsafe {
        AXValueGetValue(
            value.as_CFTypeRef(),
            kAXValueTypeCFRange,
            &mut range as *mut _ as *mut std::ffi::c_void,
        )
    };
    ok.then_some((range.location as f64, range.length as f64))
}

#[napi]
pub fn read_selection() -> SelectionInfo {
    match focused_element_ref() {
        Ok(el) => {
            let role = el.string_attr("AXRole");
            let subrole = el.string_attr("AXSubrole");
            let secure = is_secure(role.as_deref(), subrole.as_deref());
            let (text, range) = if secure {
                (None, None)
            } else {
                (el.string_attr("AXSelectedText"), selected_range(&el))
            };
            let editable = !secure && el.is_settable("AXSelectedText");
            let key = element_key(&el, role.as_deref(), subrole.as_deref());
            SelectionInfo {
                ok: true,
                error: None,
                pid: el.pid(),
                role,
                subrole,
                is_secure: secure,
                text,
                range_location: range.map(|r| r.0),
                range_length: range.map(|r| r.1),
                editable,
                element_key: Some(key),
            }
        }
        Err(err) => SelectionInfo {
            ok: false,
            error: Some(ax_error_name(err)),
            pid: None,
            role: None,
            subrole: None,
            is_secure: false,
            text: None,
            range_location: None,
            range_length: None,
            editable: false,
            element_key: None,
        },
    }
}


#[napi(object)]
pub struct FieldText {
    pub ok: bool,
    pub error: Option<String>,
    pub pid: Option<i32>,
    pub is_secure: bool,
    /// The text read, at most `before + after` characters (nothing from a password field).
    pub text: Option<String>,
    /// Where `text` starts in the field.
    pub start: Option<f64>,
    /// The cursor (selection start) in the field when this was read.
    pub cursor: Option<f64>,
    pub element_key: Option<String>,
}

/// Most characters `read_text_around` will read on either side of the cursor.
const MAX_TEXT_AROUND: u32 = 2000;

/// Stage E (context awareness, auto-add to dictionary): a bounded window of the focused field's
/// text around `location` (or the cursor), via AXStringForRange. Never a password field, never
/// more than asked; the caller keeps none of it.
#[napi]
pub fn read_text_around(location: Option<f64>, before: u32, after: u32) -> FieldText {
    let fail = |error: String, pid: Option<i32>, secure: bool, key: Option<String>| FieldText {
        ok: false,
        error: Some(error),
        pid,
        is_secure: secure,
        text: None,
        start: None,
        cursor: None,
        element_key: key,
    };
    let el = match focused_element_ref() {
        Ok(el) => el,
        Err(err) => return fail(ax_error_name(err), None, false, None),
    };
    let role = el.string_attr("AXRole");
    let subrole = el.string_attr("AXSubrole");
    let key = Some(element_key(&el, role.as_deref(), subrole.as_deref()));
    if is_secure(role.as_deref(), subrole.as_deref()) {
        return fail("secure-field".into(), el.pid(), true, key);
    }
    let cursor = selected_range(&el).map(|r| r.0);
    let Some(at) = location.or(cursor) else {
        return fail("no-cursor".into(), el.pid(), false, key);
    };
    let total = el
        .copy_attr("AXNumberOfCharacters")
        .ok()
        .and_then(|v| v.downcast::<core_foundation::number::CFNumber>())
        .and_then(|n| n.to_i64());
    let (before, after) = (i64::from(before.min(MAX_TEXT_AROUND)), i64::from(after.min(MAX_TEXT_AROUND)));
    // `at` comes from JS: NaN casts to 0, out-of-range values saturate, so nothing here can wrap.
    let at = at as i64;
    let start = at.saturating_sub(before).max(0);
    let mut end = at.saturating_add(after);
    if let Some(total) = total {
        end = end.min(total);
    }
    if end <= start {
        return FieldText {
            ok: true,
            error: None,
            pid: el.pid(),
            is_secure: false,
            text: Some(String::new()),
            start: Some(start as f64),
            cursor,
            element_key: key,
        };
    }
    let range = core_foundation_sys::base::CFRange {
        location: start as isize,
        length: (end - start) as isize,
    };
    let text = unsafe {
        let param = AXValueCreate(kAXValueTypeCFRange, &range as *const _ as *const std::ffi::c_void);
        if param.is_null() {
            return fail("range".into(), el.pid(), false, key);
        }
        let attr = CFString::new("AXStringForRange");
        let mut value: CFTypeRef = ptr::null();
        let err = AXUIElementCopyParameterizedAttributeValue(
            el.0,
            attr.as_concrete_TypeRef(),
            param,
            &mut value,
        );
        CFRelease(param);
        if err != kAXErrorSuccess || value.is_null() {
            return fail(ax_error_name(err), el.pid(), false, key);
        }
        CFType::wrap_under_create_rule(value)
            .downcast::<CFString>()
            .map(|s| s.to_string())
    };
    FieldText {
        ok: text.is_some(),
        error: text.is_none().then(|| "not-text".into()),
        pid: el.pid(),
        is_secure: false,
        text,
        start: Some(start as f64),
        cursor,
        element_key: key,
    }
}

/// Vibe coding (file tagging): the title of the window holding the focused field, as editors
/// show it ("index.tsx — project"). Nothing else is read, and nothing from a password field's
/// window: a secure focused field returns None.
#[napi]
pub fn focused_window_title() -> Option<String> {
    let el = focused_element_ref().ok()?;
    let role = el.string_attr("AXRole");
    let subrole = el.string_attr("AXSubrole");
    if is_secure(role.as_deref(), subrole.as_deref()) {
        return None;
    }
    let window = el.copy_attr("AXWindow").ok()?;
    let raw = window.as_CFTypeRef();
    unsafe { core_foundation_sys::base::CFRetain(raw) };
    let window = Element(raw as AXUIElementRef);
    window.string_attr("AXTitle").filter(|t| t.len() <= 1000)
}
