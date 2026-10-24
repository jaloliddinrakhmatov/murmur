//! Listen-only CGEventTap for modifier-only shortcuts (Right Option, Fn, Ctrl+Opt).
//!
//! Listen-only taps need Input Monitoring, not Accessibility. The tap runs its own CFRunLoop
//! on a dedicated thread so it works in plain Node as well as in Electron.

use super::ffi::*;
use crate::now_ms;
use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFRetain};
use core_foundation_sys::mach_port::{CFMachPortCreateRunLoopSource, CFMachPortInvalidate};
use core_foundation_sys::runloop::{
    kCFRunLoopCommonModes, CFRunLoopAddSource, CFRunLoopGetCurrent, CFRunLoopRef, CFRunLoopRun,
    CFRunLoopStop,
};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::Status;
use napi_derive::napi;
use std::ffi::c_void;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread::JoinHandle;

#[napi(object)]
#[derive(Clone)]
pub struct KeyEvent {
    /// "down" | "up" | "flags"
    pub kind: String,
    pub keycode: u32,
    pub flags: f64,
    pub is_repeat: bool,
    pub t_ms: f64,
}

pub type KeyCallback = ThreadsafeFunction<KeyEvent, (), KeyEvent, Status, false>;

struct TapContext {
    port: CFMachPortRef,
    callback: KeyCallback,
}

struct Running {
    run_loop: usize,
    thread: JoinHandle<()>,
}

static RUNNING: Mutex<Option<Running>> = Mutex::new(None);

extern "C" fn on_event(
    _proxy: CGEventTapProxy,
    ty: CGEventType,
    event: CGEventRef,
    user: *mut c_void,
) -> CGEventRef {
    let ctx = unsafe { &*(user as *const TapContext) };
    if ty == kCGEventTapDisabledByTimeout || ty == kCGEventTapDisabledByUserInput {
        // macOS disables taps whose callback is slow; re-enable rather than silently going deaf.
        unsafe { CGEventTapEnable(ctx.port, true) };
        return event;
    }
    let kind = match ty {
        kCGEventKeyDown => "down",
        kCGEventKeyUp => "up",
        kCGEventFlagsChanged => "flags",
        _ => return event,
    };
    let (keycode, flags, is_repeat) = unsafe {
        (
            CGEventGetIntegerValueField(event, kCGKeyboardEventKeycode) as u32,
            CGEventGetFlags(event) as f64,
            CGEventGetIntegerValueField(event, kCGKeyboardEventAutorepeat) != 0,
        )
    };
    ctx.callback.call(
        KeyEvent {
            kind: kind.to_string(),
            keycode,
            flags,
            is_repeat,
            t_ms: now_ms(),
        },
        ThreadsafeFunctionCallMode::NonBlocking,
    );
    event
}

#[napi(object)]
pub struct TapStartOptions {
    /// Show the Input Monitoring prompt if not yet granted. Default false.
    pub request_permission: Option<bool>,
}

#[napi(object)]
pub struct TapStartResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[napi]
pub fn start_key_tap(options: Option<TapStartOptions>, callback: KeyCallback) -> TapStartResult {
    let mut running = RUNNING.lock().unwrap();
    if running.is_some() {
        return TapStartResult {
            ok: false,
            error: Some("already-running".into()),
        };
    }
    if !unsafe { CGPreflightListenEventAccess() } {
        if options.and_then(|o| o.request_permission).unwrap_or(false) {
            unsafe { CGRequestListenEventAccess() };
        }
        return TapStartResult {
            ok: false,
            error: Some("input-monitoring-not-granted".into()),
        };
    }

    let (tx, rx) = mpsc::channel::<Result<usize, String>>();
    let thread = std::thread::spawn(move || unsafe {
        let ctx = Box::into_raw(Box::new(TapContext {
            port: std::ptr::null_mut(),
            callback,
        }));
        let mask = (1u64 << kCGEventKeyDown) | (1u64 << kCGEventKeyUp) | (1u64 << kCGEventFlagsChanged);
        let port = CGEventTapCreate(
            kCGSessionEventTap,
            kCGHeadInsertEventTap,
            kCGEventTapOptionListenOnly,
            mask,
            on_event,
            ctx as *mut c_void,
        );
        if port.is_null() {
            drop(Box::from_raw(ctx));
            let _ = tx.send(Err("tap-create-failed".into()));
            return;
        }
        (*ctx).port = port;
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port as _, 0);
        let run_loop = CFRunLoopGetCurrent();
        CFRunLoopAddSource(run_loop, source, kCFRunLoopCommonModes);
        CGEventTapEnable(port, true);
        // The stopping thread holds this reference: a thread's run loop is freed when the thread
        // exits, and stop_key_tap may call CFRunLoopStop after that (found in M2: PAC trap).
        CFRetain(run_loop as _);
        let _ = tx.send(Ok(run_loop as usize));
        CFRunLoopRun();
        CGEventTapEnable(port, false);
        CFMachPortInvalidate(port as _);
        CFRelease(source as _);
        CFRelease(port as _);
        drop(Box::from_raw(ctx));
    });

    match rx.recv() {
        Ok(Ok(run_loop)) => {
            *running = Some(Running { run_loop, thread });
            TapStartResult { ok: true, error: None }
        }
        Ok(Err(e)) => {
            let _ = thread.join();
            TapStartResult { ok: false, error: Some(e) }
        }
        Err(_) => TapStartResult {
            ok: false,
            error: Some("tap-thread-died".into()),
        },
    }
}

#[napi]
pub fn stop_key_tap() -> bool {
    let Some(running) = RUNNING.lock().unwrap().take() else {
        return false;
    };
    // A stop sent before the thread enters CFRunLoopRun is dropped, so repeat until it exits. The
    // run loop object is retained (see start_key_tap), so stopping it after the thread ended is safe.
    for _ in 0..200 {
        if running.thread.is_finished() {
            break;
        }
        unsafe { CFRunLoopStop(running.run_loop as CFRunLoopRef) };
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    let finished = running.thread.is_finished();
    let joined = finished && running.thread.join().is_ok();
    if finished {
        unsafe { CFRelease(running.run_loop as _) };
    }
    joined
}
