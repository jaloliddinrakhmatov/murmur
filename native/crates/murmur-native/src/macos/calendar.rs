//! Calendar events through EventKit (Settings → Connectors). Google, Outlook/Exchange and iCloud
//! calendars the person added to macOS Calendar are readable here without any OAuth app.
//!
//! Nothing asks for access on its own: `request_calendar_access` is called only from the
//! person's click on Connect, and macOS shows its prompt then. The prompt can wait for as long
//! as the person takes, so the request (and the event fetch) run on worker threads and resolve
//! promises, as `SystemAudioTap.start()` does. macOS terminates an app that requests access
//! without `NSCalendarsFullAccessUsageDescription` in its Info.plist (the dev Electron binary
//! has none), so the request checks for it first and refuses instead.
use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::{AnyClass, AnyObject, Bool};
use objc2::msg_send;
use objc2_foundation::{NSArray, NSBundle, NSDate, NSError, NSString};
use std::sync::{mpsc, OnceLock};

#[link(name = "EventKit", kind = "framework")]
extern "C" {}

/// EKEntityTypeEvent.
const ENTITY_EVENT: usize = 0;
/// EKEventStatusCanceled.
const STATUS_CANCELED: isize = 3;
/// Longest notes text handed to JavaScript (only used to find a meeting link).
const NOTES_MAX: usize = 4000;
/// Most calendars listed.
const CALENDARS_MAX: usize = 200;

fn store_class() -> Option<&'static AnyClass> {
    AnyClass::get(c"EKEventStore")
}

/// "authorized" (full access), "not-determined", "denied", "restricted", "write-only" (macOS 14:
/// can add events but not read them) or "unsupported-os". Asks nothing.
#[napi]
pub fn calendar_access() -> String {
    let Some(cls) = store_class() else {
        return "unsupported-os".into();
    };
    let status: isize = unsafe { msg_send![cls, authorizationStatusForEntityType: ENTITY_EVENT] };
    match status {
        0 => "not-determined",
        1 => "restricted",
        2 => "denied",
        3 => "authorized",
        4 => "write-only",
        _ => "denied",
    }
    .into()
}

/// "available", "unsupported-os" (before macOS 14, which introduced full-access requests) or
/// "missing-usage-description" (the app's Info.plist lacks NSCalendarsFullAccessUsageDescription,
/// as in development builds). Asks nothing.
#[napi]
pub fn calendar_support() -> String {
    let Some(cls) = store_class() else {
        return "unsupported-os".into();
    };
    if !cls.responds_to(objc2::sel!(requestFullAccessToEventsWithCompletion:)) {
        return "unsupported-os".into();
    }
    let described = autoreleasepool(|_| {
        let key = NSString::from_str("NSCalendarsFullAccessUsageDescription");
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

#[napi(object)]
pub struct NativeCalendarEvent {
    /// EKEvent.eventIdentifier: shared by every occurrence of a repeating event.
    pub id: String,
    pub title: String,
    /// Milliseconds since the epoch.
    pub start_ms: f64,
    pub end_ms: f64,
    pub all_day: bool,
    pub calendar: String,
    /// The account the calendar belongs to (EKSource title, e.g. "iCloud" or an account name).
    pub account: String,
    /// EKSourceType: 0 local, 1 Exchange, 2 CalDAV (Google and others), 3 iCloud, 4 subscribed, 5 birthdays.
    pub source_type: i32,
    pub location: Option<String>,
    /// The event's own URL field.
    pub url: Option<String>,
    /// The first NOTES_MAX characters of the notes.
    pub notes: Option<String>,
}

#[napi(object)]
pub struct NativeCalendarInfo {
    pub title: String,
    pub account: String,
    pub source_type: i32,
}

fn ns_string(obj: &AnyObject, get: impl Fn(&AnyObject) -> Option<Retained<NSString>>) -> Option<String> {
    get(obj).map(|s| s.to_string()).filter(|s| !s.is_empty())
}

fn source_of(calendar: &AnyObject) -> (String, i32) {
    let source: Option<Retained<AnyObject>> = unsafe { msg_send![calendar, source] };
    match source {
        Some(s) => {
            let title = ns_string(&s, |o| unsafe { msg_send![o, title] }).unwrap_or_default();
            let kind: isize = unsafe { msg_send![&*s, sourceType] };
            (title, kind as i32)
        }
        None => (String::new(), 0),
    }
}

fn date_ms(event: &AnyObject, selector: &str) -> f64 {
    let date: Option<Retained<NSDate>> = unsafe {
        match selector {
            "startDate" => msg_send![event, startDate],
            _ => msg_send![event, endDate],
        }
    };
    date.map(|d| d.timeIntervalSince1970() * 1000.0).unwrap_or(0.0)
}

/// The worker thread's store, created on first use while access is granted and kept for the
/// thread's lifetime (making one costs tens of milliseconds, and every minute's reminder check
/// and every page load needs one). Dropped when access is no longer granted, so a store made
/// before a grant is never reused after it. Only the worker thread ever touches it: EKEventStore
/// is not thread-safe.
fn store_for(slot: &mut Option<Retained<AnyObject>>) -> Result<&AnyObject> {
    if calendar_access() != "authorized" {
        *slot = None;
        return Err(Error::new(Status::GenericFailure, "not-authorized"));
    }
    if slot.is_none() {
        let cls =
            store_class().ok_or_else(|| Error::new(Status::GenericFailure, "unsupported-os"))?;
        *slot = Some(unsafe { msg_send![cls, new] });
    }
    let store = slot.as_deref().expect("store was just created");
    // Pick up changes other apps made to the calendars since the store last looked.
    let _: () = unsafe { msg_send![store, refreshSourcesIfNecessary] };
    Ok(store)
}

fn fetch_events(
    slot: &mut Option<Retained<AnyObject>>,
    from_ms: f64,
    to_ms: f64,
    max: usize,
) -> Result<Vec<NativeCalendarEvent>> {
    let store = store_for(slot)?;
    Ok(autoreleasepool(|_| {
        let start = NSDate::dateWithTimeIntervalSince1970(from_ms / 1000.0);
        let end = NSDate::dateWithTimeIntervalSince1970(to_ms / 1000.0);
        let nil: *const AnyObject = std::ptr::null();
        let predicate: Option<Retained<AnyObject>> = unsafe {
            msg_send![store, predicateForEventsWithStartDate: &*start, endDate: &*end, calendars: nil]
        };
        let Some(predicate) = predicate else {
            return Vec::new();
        };
        let found: Option<Retained<NSArray<AnyObject>>> =
            unsafe { msg_send![store, eventsMatchingPredicate: &*predicate] };
        let mut out = Vec::new();
        for event in found.iter().flat_map(|a| a.iter()) {
            let status: isize = unsafe { msg_send![&*event, status] };
            if status == STATUS_CANCELED {
                continue;
            }
            let all_day: Bool = unsafe { msg_send![&*event, isAllDay] };
            let calendar: Option<Retained<AnyObject>> = unsafe { msg_send![&*event, calendar] };
            let (calendar_title, account, source_type) = match calendar {
                Some(c) => {
                    let title = ns_string(&c, |o| unsafe { msg_send![o, title] }).unwrap_or_default();
                    let (account, kind) = source_of(&c);
                    (title, account, kind)
                }
                None => (String::new(), String::new(), 0),
            };
            let url: Option<Retained<AnyObject>> = unsafe { msg_send![&*event, URL] };
            let url = url.and_then(|u| ns_string(&u, |o| unsafe { msg_send![o, absoluteString] }));
            out.push(NativeCalendarEvent {
                id: ns_string(&event, |o| unsafe { msg_send![o, eventIdentifier] }).unwrap_or_default(),
                title: ns_string(&event, |o| unsafe { msg_send![o, title] }).unwrap_or_default(),
                start_ms: date_ms(&event, "startDate"),
                end_ms: date_ms(&event, "endDate"),
                all_day: all_day.as_bool(),
                calendar: calendar_title,
                account,
                source_type,
                location: ns_string(&event, |o| unsafe { msg_send![o, location] }),
                url,
                notes: ns_string(&event, |o| unsafe { msg_send![o, notes] })
                    .map(|n| n.chars().take(NOTES_MAX).collect()),
            });
        }
        out.sort_by(|a, b| a.start_ms.total_cmp(&b.start_ms));
        out.truncate(max);
        out
    }))
}

fn fetch_calendars(slot: &mut Option<Retained<AnyObject>>) -> Result<Vec<NativeCalendarInfo>> {
    let store = store_for(slot)?;
    Ok(autoreleasepool(|_| {
        let found: Option<Retained<NSArray<AnyObject>>> =
            unsafe { msg_send![store, calendarsForEntityType: ENTITY_EVENT] };
        found
            .iter()
            .flat_map(|a| a.iter())
            .take(CALENDARS_MAX)
            .map(|c| {
                let (account, source_type) = source_of(&c);
                NativeCalendarInfo {
                    title: ns_string(&c, |o| unsafe { msg_send![o, title] }).unwrap_or_default(),
                    account,
                    source_type,
                }
            })
            .collect()
    }))
}

/// Asks macOS for full calendar access and waits for the answer.
fn request_access() -> Result<String> {
    match calendar_support().as_str() {
        "available" => {}
        other => return Err(Error::new(Status::GenericFailure, other)),
    }
    let cls = store_class().ok_or_else(|| Error::new(Status::GenericFailure, "unsupported-os"))?;
    let (tx, rx) = mpsc::channel::<bool>();
    let store: Retained<AnyObject> = unsafe { msg_send![cls, new] };
    let block = block2::RcBlock::new(move |granted: Bool, _error: *mut NSError| {
        let _ = tx.send(granted.as_bool());
    });
    unsafe {
        let _: () = msg_send![&*store, requestFullAccessToEventsWithCompletion: &*block];
    }
    // The prompt is answered whenever the person answers; a dropped sender means no answer came.
    rx.recv()
        .map_err(|_| Error::new(Status::GenericFailure, "no-answer"))?;
    drop(store);
    Ok(calendar_access())
}

#[derive(Clone)]
pub enum Job {
    Request,
    Events { from_ms: f64, to_ms: f64, max: usize },
    Calendars,
}

pub enum JobOutput {
    Access(String),
    Events(Vec<NativeCalendarEvent>),
    Calendars(Vec<NativeCalendarInfo>),
}

pub struct RequestTask(Job);
pub struct EventsTask(Job);
pub struct CalendarsTask(Job);

type Reply = mpsc::Sender<Result<JobOutput>>;

/// Reads run on one dedicated thread that owns the EKEventStore. Asking for access does not: it
/// can wait for the person for as long as they take and must not hold up reads.
fn reader() -> Option<&'static mpsc::Sender<(Job, Reply)>> {
    static READER: OnceLock<Option<mpsc::Sender<(Job, Reply)>>> = OnceLock::new();
    READER
        .get_or_init(|| {
            let (tx, rx) = mpsc::channel::<(Job, Reply)>();
            std::thread::Builder::new()
                .name("murmur-eventkit".into())
                .spawn(move || {
                    let mut store: Option<Retained<AnyObject>> = None;
                    for (job, reply) in rx {
                        let out = autoreleasepool(|_| match &job {
                            Job::Events { from_ms, to_ms, max } => {
                                fetch_events(&mut store, *from_ms, *to_ms, *max)
                                    .map(JobOutput::Events)
                            }
                            Job::Calendars => {
                                fetch_calendars(&mut store).map(JobOutput::Calendars)
                            }
                            Job::Request => Err(Error::new(Status::GenericFailure, "unexpected")),
                        });
                        let _ = reply.send(out);
                    }
                })
                .ok()?;
            Some(tx)
        })
        .as_ref()
}

fn run(job: &Job) -> Result<JobOutput> {
    if let Job::Request = job {
        return request_access().map(JobOutput::Access);
    }
    let unavailable = || Error::new(Status::GenericFailure, "calendar-worker-unavailable");
    let (reply, answer) = mpsc::channel();
    reader()
        .ok_or_else(unavailable)?
        .send((job.clone(), reply))
        .map_err(|_| unavailable())?;
    answer.recv().map_err(|_| unavailable())?
}

impl Task for RequestTask {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        match run(&self.0)? {
            JobOutput::Access(s) => Ok(s),
            _ => Err(Error::new(Status::GenericFailure, "unexpected")),
        }
    }
    fn resolve(&mut self, _env: Env, output: String) -> Result<String> {
        Ok(output)
    }
}

impl Task for EventsTask {
    type Output = Vec<NativeCalendarEvent>;
    type JsValue = Vec<NativeCalendarEvent>;
    fn compute(&mut self) -> Result<Self::Output> {
        match run(&self.0)? {
            JobOutput::Events(e) => Ok(e),
            _ => Err(Error::new(Status::GenericFailure, "unexpected")),
        }
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl Task for CalendarsTask {
    type Output = Vec<NativeCalendarInfo>;
    type JsValue = Vec<NativeCalendarInfo>;
    fn compute(&mut self) -> Result<Self::Output> {
        match run(&self.0)? {
            JobOutput::Calendars(c) => Ok(c),
            _ => Err(Error::new(Status::GenericFailure, "unexpected")),
        }
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Shows macOS's calendar prompt (the first time) and resolves with the access afterwards.
/// Rejects with "missing-usage-description" or "unsupported-os" without asking anything. Only
/// call from the person's click.
#[napi(ts_return_type = "Promise<string>")]
pub fn request_calendar_access() -> AsyncTask<RequestTask> {
    AsyncTask::new(RequestTask(Job::Request))
}

/// Events starting between the two times, earliest first. Rejects with "not-authorized" unless
/// access is already granted (it never prompts).
#[napi(ts_return_type = "Promise<NativeCalendarEvent[]>")]
pub fn list_upcoming_events(from_ms: f64, to_ms: f64, max: u32) -> AsyncTask<EventsTask> {
    AsyncTask::new(EventsTask(Job::Events {
        from_ms,
        to_ms,
        max: max.min(500) as usize,
    }))
}

/// The calendars macOS Calendar shows, with their accounts. Rejects with "not-authorized".
#[napi(ts_return_type = "Promise<NativeCalendarInfo[]>")]
pub fn list_calendars() -> AsyncTask<CalendarsTask> {
    AsyncTask::new(CalendarsTask(Job::Calendars))
}
