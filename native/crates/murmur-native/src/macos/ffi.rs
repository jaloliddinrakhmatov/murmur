//! Raw declarations for the macOS C APIs used by the prototype (ApplicationServices,
//! CoreGraphics, Carbon/HIToolbox). Kept in one place so every unsafe boundary is visible.
#![allow(non_upper_case_globals, non_snake_case, dead_code)]

use core_foundation_sys::array::CFArrayRef;
use core_foundation_sys::base::CFTypeRef;
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use std::ffi::c_void;

pub type OSStatus = i32;
pub type AXError = i32;
pub type AXUIElementRef = *const c_void;
pub type CGEventRef = *mut c_void;
pub type CGEventTapProxy = *mut c_void;
pub type CGEventSourceRef = *mut c_void;
pub type CFMachPortRef = *mut c_void;
pub type CGEventMask = u64;
pub type CGEventType = u32;
pub type CGEventFlags = u64;
pub type EventTargetRef = *mut c_void;
pub type EventHotKeyRef = *mut c_void;
pub type EventHandlerRef = *mut c_void;
pub type EventHandlerCallRef = *mut c_void;
pub type EventRef = *mut c_void;
pub type TISInputSourceRef = *mut c_void;

pub const kAXErrorSuccess: AXError = 0;
pub const kAXErrorCannotComplete: AXError = -25204;
pub const kAXErrorAttributeUnsupported: AXError = -25205;
pub const kAXErrorAPIDisabled: AXError = -25211;
pub const kAXErrorNoValue: AXError = -25212;

pub const kCGEventKeyDown: CGEventType = 10;
pub const kCGEventKeyUp: CGEventType = 11;
pub const kCGEventFlagsChanged: CGEventType = 12;
pub const kCGEventTapDisabledByTimeout: CGEventType = 0xFFFF_FFFE;
pub const kCGEventTapDisabledByUserInput: CGEventType = 0xFFFF_FFFF;

pub const kCGSessionEventTap: u32 = 1;
pub const kCGHIDEventTap: u32 = 0;
pub const kCGHeadInsertEventTap: u32 = 0;
pub const kCGEventTapOptionListenOnly: u32 = 1;
pub const kCGKeyboardEventAutorepeat: u32 = 8;
pub const kCGKeyboardEventKeycode: u32 = 9;
pub const kCGEventSourceStateHIDSystemState: i32 = 1;

pub const kCGEventFlagMaskShift: CGEventFlags = 0x0002_0000;
pub const kCGEventFlagMaskControl: CGEventFlags = 0x0004_0000;
pub const kCGEventFlagMaskAlternate: CGEventFlags = 0x0008_0000;
pub const kCGEventFlagMaskCommand: CGEventFlags = 0x0010_0000;
pub const kCGEventFlagMaskSecondaryFn: CGEventFlags = 0x0080_0000;

pub const kCGWindowListOptionOnScreenOnly: u32 = 1;
pub const kCGWindowListExcludeDesktopElements: u32 = 16;

pub const kEventHotKeyPressed: u32 = 5;
pub const kEventHotKeyReleased: u32 = 6;
pub const kEventHotKeyNoOptions: u32 = 0;
pub const kEventHotKeyExclusive: u32 = 1;
pub const eventHotKeyExistsErr: OSStatus = -9878;
pub const eventHotKeyInvalidErr: OSStatus = -9879;

pub const kUCKeyActionDisplay: u16 = 3;
pub const kUCKeyTranslateNoDeadKeysMask: u32 = 1;

pub const fn fourcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
}
pub const kEventClassKeyboard: u32 = fourcc(b"keyb");
pub const kEventParamDirectObject: u32 = fourcc(b"----");
pub const typeEventHotKeyID: u32 = fourcc(b"hkid");

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct EventHotKeyID {
    pub signature: u32,
    pub id: u32,
}

#[repr(C)]
pub struct EventTypeSpec {
    pub event_class: u32,
    pub event_kind: u32,
}

pub type CGEventTapCallBack =
    extern "C" fn(CGEventTapProxy, CGEventType, CGEventRef, *mut c_void) -> CGEventRef;
pub type EventHandlerProcPtr =
    extern "C" fn(EventHandlerCallRef, EventRef, *mut c_void) -> OSStatus;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub static kAXTrustedCheckOptionPrompt: CFStringRef;
    pub fn AXIsProcessTrusted() -> bool;
    pub fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
    pub fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    pub fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    pub fn AXUIElementIsAttributeSettable(
        element: AXUIElementRef,
        attribute: CFStringRef,
        settable: *mut u8,
    ) -> AXError;
    pub fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> AXError;
    pub fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, seconds: f32) -> AXError;
    pub fn AXValueGetValue(value: CFTypeRef, the_type: u32, value_ptr: *mut c_void) -> bool;
    pub fn AXValueCreate(the_type: u32, value_ptr: *const c_void) -> CFTypeRef;
    pub fn AXUIElementCopyParameterizedAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        parameter: CFTypeRef,
        result: *mut CFTypeRef,
    ) -> AXError;
    pub fn AXValueGetTypeID() -> core_foundation_sys::base::CFTypeID;
}

/// `kAXValueTypeCFRange` (AXValue.h).
pub const kAXValueTypeCFRange: u32 = 4;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    pub static kCGWindowLayer: CFStringRef;
    pub static kCGWindowOwnerPID: CFStringRef;
    pub static kCGWindowOwnerName: CFStringRef;
    pub fn CGPreflightListenEventAccess() -> bool;
    pub fn CGRequestListenEventAccess() -> bool;
    pub fn CGPreflightPostEventAccess() -> bool;
    pub fn CGEventTapCreate(
        tap: u32,
        place: u32,
        options: u32,
        events_of_interest: CGEventMask,
        callback: CGEventTapCallBack,
        user_info: *mut c_void,
    ) -> CFMachPortRef;
    pub fn CGEventTapEnable(tap: CFMachPortRef, enable: bool);
    pub fn CGEventGetIntegerValueField(event: CGEventRef, field: u32) -> i64;
    pub fn CGEventGetFlags(event: CGEventRef) -> CGEventFlags;
    pub fn CGEventSourceCreate(state: i32) -> CGEventSourceRef;
    pub fn CGEventSourceFlagsState(state: i32) -> CGEventFlags;
    pub fn CGEventCreateKeyboardEvent(
        source: CGEventSourceRef,
        keycode: u16,
        key_down: bool,
    ) -> CGEventRef;
    pub fn CGEventSetFlags(event: CGEventRef, flags: CGEventFlags);
    pub fn CGEventPost(tap: u32, event: CGEventRef);
    pub fn CGEventKeyboardSetUnicodeString(event: CGEventRef, length: usize, string: *const u16);
    pub fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    pub static kTISPropertyUnicodeKeyLayoutData: CFStringRef;
    pub static kTISPropertyInputSourceID: CFStringRef;
    pub static kTISPropertyInputSourceType: CFStringRef;
    pub static kTISTypeKeyboardLayout: CFStringRef;
    pub fn IsSecureEventInputEnabled() -> bool;
    pub fn EnableSecureEventInput() -> OSStatus;
    pub fn DisableSecureEventInput() -> OSStatus;
    pub fn GetApplicationEventTarget() -> EventTargetRef;
    pub fn InstallEventHandler(
        target: EventTargetRef,
        handler: EventHandlerProcPtr,
        num_types: u32,
        list: *const EventTypeSpec,
        user_data: *mut c_void,
        out_ref: *mut EventHandlerRef,
    ) -> OSStatus;
    pub fn RegisterEventHotKey(
        key_code: u32,
        modifiers: u32,
        id: EventHotKeyID,
        target: EventTargetRef,
        options: u32,
        out_ref: *mut EventHotKeyRef,
    ) -> OSStatus;
    pub fn UnregisterEventHotKey(hot_key: EventHotKeyRef) -> OSStatus;
    pub fn GetEventKind(event: EventRef) -> u32;
    pub fn GetEventParameter(
        event: EventRef,
        name: u32,
        desired_type: u32,
        actual_type: *mut u32,
        buffer_size: usize,
        actual_size: *mut usize,
        data: *mut c_void,
    ) -> OSStatus;
    pub fn TISCopyCurrentKeyboardLayoutInputSource() -> TISInputSourceRef;
    pub fn TISCreateInputSourceList(
        properties: CFDictionaryRef,
        include_all_installed: bool,
    ) -> CFArrayRef;
    pub fn TISGetInputSourceProperty(source: TISInputSourceRef, key: CFStringRef) -> *const c_void;
    pub fn UCKeyTranslate(
        layout: *const c_void,
        virtual_key_code: u16,
        key_action: u16,
        modifier_key_state: u32,
        keyboard_type: u32,
        options: u32,
        dead_key_state: *mut u32,
        max_length: usize,
        actual_length: *mut usize,
        unicode_string: *mut u16,
    ) -> OSStatus;
    pub fn LMGetKbdType() -> u8;
}
