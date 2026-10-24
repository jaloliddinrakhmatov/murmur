//! System audio for meeting recording (Stage 9D-2): a Core Audio process tap of what this Mac
//! plays (other apps only: Murmur's own process is excluded), read through a private aggregate
//! device and handed to JavaScript as 16 kHz mono PCM16.
//!
//! Nothing here starts on its own: `SystemAudioTap.start()` is called only when the person starts
//! a meeting recording, and macOS asks for "System Audio Recording" the first time. That prompt
//! can wait for as long as the person takes, so `start` runs on a worker thread and resolves a
//! promise: the app never freezes behind it. The tap functions exist from macOS 14.2 and are
//! looked up at run time, so the addon still loads on older systems. macOS refuses an app whose
//! Info.plist lacks `NSAudioCaptureUsageDescription`, so `start` checks for it first.
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use objc2::rc::{autoreleasepool, Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2::msg_send;
use objc2_foundation::{NSArray, NSBundle, NSNumber, NSString, NSUUID};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

type AudioObjectID = u32;
type OSStatus = i32;
type IoProcId = *mut c_void;

const fn fourcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
}
const SYSTEM_OBJECT: AudioObjectID = 1;
const SCOPE_GLOBAL: u32 = fourcc(b"glob");
const DEFAULT_OUTPUT_DEVICE: u32 = fourcc(b"dOut");
const DEVICE_UID: u32 = fourcc(b"uid ");
const PID_TO_PROCESS: u32 = fourcc(b"id2p");
const TAP_FORMAT: u32 = fourcc(b"tfmt");
const FORMAT_LINEAR_PCM: u32 = fourcc(b"lpcm");
const FLAG_FLOAT: u32 = 1;
const FLAG_NON_INTERLEAVED: u32 = 1 << 5;
const SCOPE_INPUT: u32 = fourcc(b"inpt");
const STREAM_CONFIGURATION: u32 = fourcc(b"slay");
const NOMINAL_RATE: u32 = fourcc(b"nsrt");
const DEVICE_IS_ALIVE: u32 = fourcc(b"livn");

/// Output rate: what every transcription provider receives.
const OUT_RATE: f64 = 16_000.0;
/// Most audio kept when JavaScript stops reading (60 s of 16 kHz mono); older samples go first.
const MAX_OUT_SAMPLES: usize = 60 * 16_000;
/// Slack so a callback never grows `out` past its allocation on the I/O thread.
const OUT_HEADROOM: usize = 32_768;
/// Most tap buffers read per callback (a tap is stereo: one or two buffers).
const MAX_TAP_BUFFERS: usize = 8;

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct StreamFormat {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
struct AudioBuffer {
    channels: u32,
    bytes: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    count: u32,
    buffers: [AudioBuffer; 1],
}

type IoProc = extern "C" fn(
    AudioObjectID,
    *const c_void,
    *const AudioBufferList,
    *const c_void,
    *mut AudioBufferList,
    *const c_void,
    *mut c_void,
) -> OSStatus;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        id: AudioObjectID,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
        data: *mut c_void,
    ) -> OSStatus;
    fn AudioObjectSetPropertyData(
        id: AudioObjectID,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: u32,
        data: *const c_void,
    ) -> OSStatus;
    fn AudioObjectGetPropertyDataSize(
        id: AudioObjectID,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        size: *mut u32,
    ) -> OSStatus;
    fn AudioObjectHasProperty(id: AudioObjectID, address: *const PropertyAddress) -> u8;
    fn AudioHardwareCreateAggregateDevice(
        description: CFDictionaryRef,
        out: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(id: AudioObjectID) -> OSStatus;
    fn AudioDeviceCreateIOProcID(
        device: AudioObjectID,
        proc_: IoProc,
        client: *mut c_void,
        out: *mut IoProcId,
    ) -> OSStatus;
    fn AudioDeviceDestroyIOProcID(device: AudioObjectID, proc_: IoProcId) -> OSStatus;
    fn AudioDeviceStart(device: AudioObjectID, proc_: IoProcId) -> OSStatus;
    fn AudioDeviceStop(device: AudioObjectID, proc_: IoProcId) -> OSStatus;
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const std::ffi::c_char) -> *mut c_void;
}
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

type CreateTap = unsafe extern "C" fn(*mut AnyObject, *mut AudioObjectID) -> OSStatus;
type DestroyTap = unsafe extern "C" fn(AudioObjectID) -> OSStatus;

/// The process-tap functions (macOS 14.2+), found at run time.
fn tap_functions() -> Option<(CreateTap, DestroyTap)> {
    unsafe {
        let create = dlsym(RTLD_DEFAULT, c"AudioHardwareCreateProcessTap".as_ptr());
        let destroy = dlsym(RTLD_DEFAULT, c"AudioHardwareDestroyProcessTap".as_ptr());
        if create.is_null() || destroy.is_null() {
            return None;
        }
        Some((
            std::mem::transmute::<*mut c_void, CreateTap>(create),
            std::mem::transmute::<*mut c_void, DestroyTap>(destroy),
        ))
    }
}

/// "available", "unsupported-os" (before macOS 14.2) or "missing-usage-description" (the app's
/// Info.plist lacks NSAudioCaptureUsageDescription, as in development builds). Asks nothing.
#[napi]
pub fn system_audio_support() -> String {
    if tap_functions().is_none() || AnyClass::get(c"CATapDescription").is_none() {
        return "unsupported-os".into();
    }
    let described = autoreleasepool(|_| {
        let key = NSString::from_str("NSAudioCaptureUsageDescription");
        NSBundle::mainBundle()
            .objectForInfoDictionaryKey(&key)
            .is_some()
    });
    if described {
        "available".into()
    } else {
        "missing-usage-description".into()
    }
}

/// Box-filter decimator from the tap's rate to 16 kHz (averaging also keeps the higher
/// frequencies from folding into speech).
struct Converter {
    step: f64,
    acc: f64,
    n: f64,
    pos: f64,
}

impl Converter {
    fn new(in_rate: f64) -> Self {
        Converter {
            step: (in_rate / OUT_RATE).max(1.0),
            acc: 0.0,
            n: 0.0,
            pos: 0.0,
        }
    }

    fn push(&mut self, x: f32, out: &mut Vec<i16>) {
        self.acc += x as f64;
        self.n += 1.0;
        self.pos += 1.0;
        if self.pos >= self.step {
            let v = (self.acc / self.n).clamp(-1.0, 1.0);
            out.push((v * 32767.0).round() as i16);
            self.acc = 0.0;
            self.n = 0.0;
            self.pos -= self.step;
        }
    }
}

struct Inner {
    converter: Converter,
    out: Vec<i16>,
}

struct Shared {
    /// How many of the aggregate device's input buffers (the last ones) belong to the tap. Any
    /// before them are the output device's own inputs (a headset's microphone) and are ignored.
    tap_buffers: usize,
    inner: Mutex<Inner>,
    /// Blocks dropped because JavaScript held the lock (the I/O thread never waits).
    dropped_blocks: AtomicU64,
    /// Set from JavaScript's `read()` once the aggregate or the output device goes away.
    lost: AtomicBool,
}

/// Runs on Core Audio's I/O thread: downmixes the tap's buffers to mono and converts. It never
/// allocates (apart from `out` filling its reserved space) and never waits for a lock.
extern "C" fn io_proc(
    _device: AudioObjectID,
    _now: *const c_void,
    input: *const AudioBufferList,
    _input_time: *const c_void,
    _output: *mut AudioBufferList,
    _output_time: *const c_void,
    client: *mut c_void,
) -> OSStatus {
    if input.is_null() || client.is_null() {
        return 0;
    }
    let shared = unsafe { &*(client as *const Shared) };
    let list = unsafe { &*input };
    let all = unsafe { std::slice::from_raw_parts(list.buffers.as_ptr(), list.count as usize) };
    let tap = &all[all.len().saturating_sub(shared.tap_buffers)..];
    let mut views: [(&[f32], usize); MAX_TAP_BUFFERS] = [(&[], 1); MAX_TAP_BUFFERS];
    let mut n = 0;
    let mut frames = usize::MAX;
    let mut total_channels = 0;
    for b in tap.iter().filter(|b| !b.data.is_null()).take(MAX_TAP_BUFFERS) {
        let channels = b.channels.max(1) as usize;
        let samples = unsafe { std::slice::from_raw_parts(b.data as *const f32, b.bytes as usize / 4) };
        frames = frames.min(samples.len() / channels);
        total_channels += channels;
        views[n] = (samples, channels);
        n += 1;
    }
    if n == 0 || frames == 0 {
        return 0;
    }
    let Ok(mut inner) = shared.inner.try_lock() else {
        shared.dropped_blocks.fetch_add(1, Ordering::Relaxed);
        return 0;
    };
    let Inner { converter, out } = &mut *inner;
    let scale = 1.0 / total_channels as f32;
    for i in 0..frames {
        let mut sum = 0.0f32;
        for (samples, channels) in &views[..n] {
            sum += samples[i * channels..(i + 1) * channels].iter().sum::<f32>();
        }
        converter.push(sum * scale, out);
    }
    if out.len() > MAX_OUT_SAMPLES {
        let excess = out.len() - MAX_OUT_SAMPLES;
        out.drain(..excess);
    }
    0
}

/// Channel count of each input buffer the aggregate device presents (the sub-device's inputs
/// first, the tap's last). Empty when it can't be read.
fn input_buffer_channels(device: AudioObjectID) -> Vec<u32> {
    let address = PropertyAddress {
        selector: STREAM_CONFIGURATION,
        scope: SCOPE_INPUT,
        element: 0,
    };
    let mut size = 0u32;
    if unsafe { AudioObjectGetPropertyDataSize(device, &address, 0, std::ptr::null(), &mut size) } != 0
        || (size as usize) < std::mem::size_of::<AudioBufferList>()
    {
        return Vec::new();
    }
    // 8-byte aligned storage for the variable-length list.
    let mut storage = vec![0u64; (size as usize).div_ceil(8)];
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            storage.as_mut_ptr() as *mut c_void,
        )
    };
    if status != 0 {
        return Vec::new();
    }
    let list = unsafe { &*(storage.as_ptr() as *const AudioBufferList) };
    let fits = (size as usize).saturating_sub(std::mem::offset_of!(AudioBufferList, buffers))
        / std::mem::size_of::<AudioBuffer>();
    let count = (list.count as usize).min(fits);
    unsafe { std::slice::from_raw_parts(list.buffers.as_ptr(), count) }
        .iter()
        .map(|b| b.channels)
        .collect()
}

/// How many trailing input buffers carry the tap's `tap_channels` channels.
fn tap_buffer_count(buffer_channels: &[u32], tap_channels: u32, interleaved_default: usize) -> usize {
    if buffer_channels.is_empty() {
        return interleaved_default;
    }
    let mut channels = 0;
    let mut count = 0;
    for c in buffer_channels.iter().rev() {
        if channels >= tap_channels {
            break;
        }
        channels += c;
        count += 1;
    }
    count.min(MAX_TAP_BUFFERS)
}

fn get<T: Default>(id: AudioObjectID, selector: u32, qualifier: Option<&i32>) -> std::result::Result<T, OSStatus> {
    let address = PropertyAddress {
        selector,
        scope: SCOPE_GLOBAL,
        element: 0,
    };
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    let (qsize, q) = match qualifier {
        Some(p) => (std::mem::size_of::<i32>() as u32, p as *const i32 as *const c_void),
        None => (0, std::ptr::null()),
    };
    let status = unsafe {
        AudioObjectGetPropertyData(id, &address, qsize, q, &mut size, &mut value as *mut T as *mut c_void)
    };
    if status == 0 {
        Ok(value)
    } else {
        Err(status)
    }
}

/// The default output device's UID (the aggregate device is clocked by it).
fn default_output_uid() -> std::result::Result<(AudioObjectID, CFString), String> {
    let device: AudioObjectID =
        get(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE, None).map_err(|s| format!("no output device ({s})"))?;
    let uid: usize = get(device, DEVICE_UID, None).map_err(|s| format!("output device UID ({s})"))?;
    if uid == 0 {
        return Err("output device has no UID".into());
    }
    Ok((device, unsafe { CFString::wrap_under_create_rule(uid as CFStringRef) }))
}

struct Running {
    output_device: AudioObjectID,
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    proc_id: IoProcId,
    shared: *const Shared,
    destroy_tap: DestroyTap,
    source_rate: f64,
}

// The ids and the shared state are plain handles: Core Audio may be called from any thread.
unsafe impl Send for Running {}

impl Running {
    fn start() -> std::result::Result<Running, String> {
        match system_audio_support().as_str() {
            "available" => {}
            "unsupported-os" => return Err("System audio needs macOS 14.2 or later.".into()),
            _ => {
                return Err(
                    "This build of Murmur can't ask macOS to record your Mac's sound.".into(),
                )
            }
        }
        let (create_tap, destroy_tap) = tap_functions().ok_or("System audio is unavailable.")?;
        let (tap, tap_uid) = autoreleasepool(|_| -> std::result::Result<(AudioObjectID, String), String> {
            let class = AnyClass::get(c"CATapDescription").ok_or("System audio is unavailable.")?;
            // Murmur's own sounds are left out of the recording.
            let own: AudioObjectID = get(SYSTEM_OBJECT, PID_TO_PROCESS, Some(&(std::process::id() as i32))).unwrap_or(0);
            let exclude: Retained<NSArray<NSNumber>> = if own != 0 {
                NSArray::from_retained_slice(&[NSNumber::new_u32(own)])
            } else {
                NSArray::new()
            };
            unsafe {
                let alloc: Allocated<AnyObject> = msg_send![class, alloc];
                let description: Option<Retained<AnyObject>> =
                    msg_send![alloc, initStereoGlobalTapButExcludeProcesses: &*exclude];
                let description = description.ok_or("Couldn't describe the system audio tap.")?;
                let uuid = NSUUID::new();
                let _: () = msg_send![&*description, setUUID: &*uuid];
                let _: () = msg_send![&*description, setPrivate: true];
                let _: () = msg_send![&*description, setMuteBehavior: 0isize];
                let mut tap: AudioObjectID = 0;
                let status = create_tap(Retained::as_ptr(&description) as *mut AnyObject, &mut tap);
                if status != 0 || tap == 0 {
                    return Err(format!("Couldn't start system audio (Core Audio {status})."));
                }
                Ok((tap, uuid.UUIDString().to_string()))
            }
        })?;

        let cleanup_tap = |e: String| {
            unsafe { destroy_tap(tap) };
            e
        };
        let format: StreamFormat = get(tap, TAP_FORMAT, None)
            .map_err(|s| cleanup_tap(format!("Couldn't read the system audio format ({s}).")))?;
        if format.format_id != FORMAT_LINEAR_PCM
            || format.format_flags & FLAG_FLOAT == 0
            || format.bits_per_channel != 32
            || format.sample_rate < OUT_RATE
        {
            return Err(cleanup_tap("System audio arrives in a format Murmur can't read.".into()));
        }
        let (output_device, output_uid) = default_output_uid().map_err(cleanup_tap)?;

        let key = |s: &str| CFString::new(s);
        let tap_entry = CFDictionary::from_CFType_pairs(&[
            (key("uid"), CFString::new(&tap_uid).as_CFType()),
            (key("drift"), CFBoolean::true_value().as_CFType()),
        ]);
        let sub_device = CFDictionary::from_CFType_pairs(&[(key("uid"), output_uid.as_CFType())]);
        let aggregate_uid = autoreleasepool(|_| NSUUID::new().UUIDString().to_string());
        let description: CFDictionary<CFString, CFType> = CFDictionary::from_CFType_pairs(&[
            (key("name"), CFString::new("Murmur meeting audio").as_CFType()),
            (key("uid"), CFString::new(&aggregate_uid).as_CFType()),
            (key("master"), output_uid.as_CFType()),
            (key("private"), CFBoolean::true_value().as_CFType()),
            (key("stacked"), CFBoolean::false_value().as_CFType()),
            (key("tapautostart"), CFBoolean::true_value().as_CFType()),
            (key("subdevices"), CFArray::from_CFTypes(&[sub_device]).as_CFType()),
            (key("taps"), CFArray::from_CFTypes(&[tap_entry]).as_CFType()),
        ]);
        let mut aggregate: AudioObjectID = 0;
        let status = unsafe { AudioHardwareCreateAggregateDevice(description.as_concrete_TypeRef(), &mut aggregate) };
        if status != 0 || aggregate == 0 {
            return Err(cleanup_tap(format!("Couldn't open system audio (Core Audio {status}).")));
        }

        // The aggregate device delivers at its own clock rate, which is the output device's and
        // can differ from the tap's. When the output device also has inputs (a headset), its
        // buffers come first and the tap's last.
        let source_rate = match get::<f64>(aggregate, NOMINAL_RATE, None) {
            Ok(rate) if rate >= OUT_RATE => rate,
            _ => format.sample_rate,
        };
        let default_buffers = if format.format_flags & FLAG_NON_INTERLEAVED != 0 {
            format.channels_per_frame.max(1) as usize
        } else {
            1
        };
        let tap_buffers = tap_buffer_count(
            &input_buffer_channels(aggregate),
            format.channels_per_frame.max(1),
            default_buffers,
        );
        let shared = Arc::into_raw(Arc::new(Shared {
            tap_buffers,
            inner: Mutex::new(Inner {
                converter: Converter::new(source_rate),
                out: Vec::with_capacity(MAX_OUT_SAMPLES + OUT_HEADROOM),
            }),
            dropped_blocks: AtomicU64::new(0),
            lost: AtomicBool::new(false),
        }));
        let mut proc_id: IoProcId = std::ptr::null_mut();
        let fail = |e: String, proc_id: IoProcId| unsafe {
            if !proc_id.is_null() {
                AudioDeviceDestroyIOProcID(aggregate, proc_id);
            }
            AudioHardwareDestroyAggregateDevice(aggregate);
            destroy_tap(tap);
            drop(Arc::from_raw(shared));
            e
        };
        let status = unsafe { AudioDeviceCreateIOProcID(aggregate, io_proc, shared as *mut c_void, &mut proc_id) };
        if status != 0 {
            return Err(fail(format!("Couldn't read system audio (Core Audio {status})."), proc_id));
        }
        let status = unsafe { AudioDeviceStart(aggregate, proc_id) };
        if status != 0 {
            return Err(fail(format!("Couldn't start system audio (Core Audio {status})."), proc_id));
        }
        Ok(Running {
            output_device,
            tap,
            aggregate,
            proc_id,
            shared,
            destroy_tap,
            source_rate,
        })
    }

    /// Takes the samples collected so far. The copy is allocated here, on the caller's thread,
    /// so the I/O thread's buffer keeps its capacity and never reallocates.
    fn drain(&self) -> Vec<i16> {
        let shared = unsafe { &*self.shared };
        let waiting = shared.inner.lock().map(|inner| inner.out.len()).unwrap_or(0);
        let mut samples = Vec::with_capacity(waiting + 4096);
        if let Ok(mut inner) = shared.inner.lock() {
            samples.extend(inner.out.drain(..));
        }
        samples
    }

    /// Why capture can no longer be trusted: the aggregate device died, or the Mac's output
    /// device changed (the aggregate is clocked by the one it started with). Sticky once set.
    fn lost_reason(&self) -> Option<&'static str> {
        let shared = unsafe { &*self.shared };
        if shared.lost.load(Ordering::Relaxed) {
            return Some("output-changed");
        }
        let alive = get::<u32>(self.aggregate, DEVICE_IS_ALIVE, None).map(|v| v != 0).unwrap_or(false);
        let same_output = get::<AudioObjectID>(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE, None)
            .map(|d| d == self.output_device)
            .unwrap_or(false);
        if alive && same_output {
            return None;
        }
        shared.lost.store(true, Ordering::Relaxed);
        Some("output-changed")
    }

    fn dropped_blocks(&self) -> u64 {
        unsafe { &*self.shared }.dropped_blocks.load(Ordering::Relaxed)
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        unsafe {
            AudioDeviceStop(self.aggregate, self.proc_id);
            AudioDeviceDestroyIOProcID(self.aggregate, self.proc_id);
            AudioHardwareDestroyAggregateDevice(self.aggregate);
            (self.destroy_tap)(self.tap);
            // The I/O proc is stopped and destroyed, so nothing else holds the shared state.
            drop(Arc::from_raw(self.shared));
        }
    }
}

/// Starts the tap on a worker thread (the first start can wait on macOS's permission prompt).
pub struct StartTask {
    slot: Arc<Mutex<Option<Running>>>,
}

impl Task for StartTask {
    type Output = ();
    type JsValue = ();

    fn compute(&mut self) -> Result<()> {
        let running = Running::start().map_err(|e| Error::new(Status::GenericFailure, e))?;
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some(running);
        }
        Ok(())
    }

    fn resolve(&mut self, _env: Env, _output: ()) -> Result<()> {
        Ok(())
    }
}

/// One system-audio capture. `read()` returns the 16 kHz mono PCM16 (little-endian bytes)
/// collected since the last call.
#[napi]
pub struct SystemAudioTap {
    slot: Arc<Mutex<Option<Running>>>,
}

#[napi]
impl SystemAudioTap {
    #[napi(constructor)]
    pub fn new() -> Self {
        SystemAudioTap {
            slot: Arc::new(Mutex::new(None)),
        }
    }

    /// Starts capturing; resolves once the tap runs. Only call when the person has started a
    /// meeting recording.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn start(&self) -> AsyncTask<StartTask> {
        AsyncTask::new(StartTask {
            slot: self.slot.clone(),
        })
    }

    #[napi]
    pub fn read(&self) -> Buffer {
        let samples = match self.slot.lock() {
            Ok(slot) => slot.as_ref().map(Running::drain).unwrap_or_default(),
            Err(_) => Vec::new(),
        };
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        bytes.into()
    }

    /// "output-changed" once the Mac's sound output device went away or was switched (the
    /// capture then no longer follows what is playing), otherwise null.
    #[napi(getter)]
    pub fn lost_reason(&self) -> Option<String> {
        self.slot
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().and_then(|r| r.lost_reason()))
            .map(String::from)
    }

    /// Blocks of sound dropped because the app was reading at that moment (diagnostics).
    #[napi(getter)]
    pub fn dropped_blocks(&self) -> f64 {
        self.slot
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|r| r.dropped_blocks() as f64))
            .unwrap_or(0.0)
    }

    /// Stops and releases the tap, the aggregate device and the I/O proc.
    #[napi]
    pub fn stop(&self) {
        let running = self.slot.lock().ok().and_then(|mut slot| slot.take());
        drop(running);
    }

    #[napi(getter)]
    pub fn running(&self) -> bool {
        self.slot.lock().map(|slot| slot.is_some()).unwrap_or(false)
    }

    /// The rate the tap delivers before conversion (0 when stopped).
    #[napi(getter)]
    pub fn source_rate(&self) -> f64 {
        self.slot
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|r| r.source_rate))
            .unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converter_averages_down_to_16k() {
        let mut c = Converter::new(48_000.0);
        let mut out = Vec::new();
        for _ in 0..4800 {
            c.push(0.5, &mut out);
        }
        assert_eq!(out.len(), 1600);
        assert!(out.iter().all(|&v| v == 16384));
    }

    #[test]
    fn tap_buffers_are_the_trailing_ones() {
        // headset: 1 mic buffer (1 ch) then a stereo tap, interleaved or not
        assert_eq!(tap_buffer_count(&[1, 2], 2, 1), 1);
        assert_eq!(tap_buffer_count(&[1, 1, 1], 2, 2), 2);
        // output device without inputs
        assert_eq!(tap_buffer_count(&[2], 2, 1), 1);
        assert_eq!(tap_buffer_count(&[1, 1], 2, 2), 2);
        // unreadable configuration
        assert_eq!(tap_buffer_count(&[], 2, 2), 2);
    }

    fn run_io(shared: &Shared, buffers: &mut [(Vec<f32>, u32)]) {
        let mut raw = vec![0u8; 8 + buffers.len() * std::mem::size_of::<AudioBuffer>()];
        let list = raw.as_mut_ptr() as *mut AudioBufferList;
        unsafe {
            (*list).count = buffers.len() as u32;
            let first = (*list).buffers.as_mut_ptr();
            for (i, (data, channels)) in buffers.iter_mut().enumerate() {
                *first.add(i) = AudioBuffer {
                    channels: *channels,
                    bytes: (data.len() * 4) as u32,
                    data: data.as_mut_ptr() as *mut c_void,
                };
            }
        }
        let list_ptr = raw.as_ptr() as *const AudioBufferList;
        io_proc(0, std::ptr::null(), list_ptr, std::ptr::null(), std::ptr::null_mut(), std::ptr::null(), shared as *const Shared as *mut c_void);
    }

    fn shared(tap_buffers: usize) -> Shared {
        Shared {
            tap_buffers,
            inner: Mutex::new(Inner {
                converter: Converter::new(16_000.0),
                out: Vec::with_capacity(MAX_OUT_SAMPLES + OUT_HEADROOM),
            }),
            dropped_blocks: AtomicU64::new(0),
            lost: AtomicBool::new(false),
        }
    }

    #[test]
    fn io_proc_ignores_the_output_devices_own_inputs() {
        // Interleaved tap after a headset microphone buffer full of loud noise.
        let s = shared(1);
        run_io(&s, &mut [(vec![0.9; 8], 1), (vec![0.5; 8], 2)]);
        let out = s.inner.lock().unwrap().out.clone();
        assert_eq!(out.len(), 4);
        assert!(out.iter().all(|&v| v == 16384));
        // Non-interleaved stereo tap after a microphone buffer.
        let s = shared(2);
        run_io(&s, &mut [(vec![0.9; 4], 1), (vec![0.5; 4], 1), (vec![0.5; 4], 1)]);
        let out = s.inner.lock().unwrap().out.clone();
        assert_eq!(out.len(), 4);
        assert!(out.iter().all(|&v| v == 16384));
    }

    #[test]
    fn io_proc_drops_instead_of_waiting_and_caps_the_backlog() {
        let s = shared(1);
        {
            let _held = s.inner.lock().unwrap();
            run_io(&s, &mut [(vec![0.5; 8], 2)]);
        }
        assert_eq!(s.dropped_blocks.load(Ordering::Relaxed), 1);
        assert!(s.inner.lock().unwrap().out.is_empty());
        let mut block = [(vec![0.25; 2 * 16_000], 2)];
        for _ in 0..70 {
            run_io(&s, &mut block);
        }
        let inner = s.inner.lock().unwrap();
        assert_eq!(inner.out.len(), MAX_OUT_SAMPLES);
        assert!(inner.out.capacity() >= MAX_OUT_SAMPLES);
    }

    #[test]
    fn converter_handles_44_1k() {
        let mut c = Converter::new(44_100.0);
        let mut out = Vec::new();
        for _ in 0..44_100 {
            c.push(0.0, &mut out);
        }
        assert!((out.len() as i64 - 16_000).abs() <= 1);
    }
}

// ---- Muting other audio while dictating (Stage E) ---------------------------------------------

const MUTE: u32 = fourcc(b"mute");
const SCOPE_OUTPUT: u32 = fourcc(b"outp");

/// The default output device's mute address: the main element, or failing that channel 1.
fn mute_address() -> Option<(AudioObjectID, PropertyAddress)> {
    let device: AudioObjectID = get(SYSTEM_OBJECT, DEFAULT_OUTPUT_DEVICE, None).ok()?;
    for element in [0u32, 1] {
        let address = PropertyAddress {
            selector: MUTE,
            scope: SCOPE_OUTPUT,
            element,
        };
        if unsafe { AudioObjectHasProperty(device, &address) } != 0 {
            return Some((device, address));
        }
    }
    None
}

/// Whether the Mac's sound output is muted; null when the output device has no mute.
#[napi]
pub fn output_muted() -> Option<bool> {
    let (device, address) = mute_address()?;
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            device,
            &address,
            0,
            std::ptr::null(),
            &mut size,
            &mut value as *mut u32 as *mut c_void,
        )
    };
    (status == 0).then_some(value != 0)
}

/// Mutes or unmutes the Mac's sound output; false when the device can't be muted.
#[napi]
pub fn set_output_muted(muted: bool) -> bool {
    let Some((device, address)) = mute_address() else {
        return false;
    };
    let value: u32 = muted.into();
    let status = unsafe {
        AudioObjectSetPropertyData(
            device,
            &address,
            0,
            std::ptr::null(),
            std::mem::size_of::<u32>() as u32,
            &value as *const u32 as *const c_void,
        )
    };
    status == 0
}
