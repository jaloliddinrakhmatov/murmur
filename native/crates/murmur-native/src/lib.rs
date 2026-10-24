//! Murmur M0 native prototype (macOS only): global hotkeys and text insertion exposed to
//! Node/Electron through napi-rs.

#[cfg(not(target_os = "macos"))]
compile_error!("The M0 native prototype targets macOS only.");

mod macos;

use murmur_core::hold::{CancelReason, Config, HoldMachine, Input, Output, State, StopReason};
use murmur_core::shortcut::{find_conflicts, validate, Action, Backend, ConflictKind, Shortcut};
use napi::{Error, Result, Status};
use napi_derive::napi;
use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

/// Milliseconds on a monotonic clock shared by every event the addon emits.
#[napi]
pub fn now_ms() -> f64 {
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[napi(object)]
pub struct ShortcutValidation {
    pub normalized: String,
    /// "carbon" (no permission) | "eventTap" (Input Monitoring)
    pub backend: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

fn parse_action(action: &str) -> Result<Action> {
    Action::parse(action).ok_or_else(|| Error::new(Status::InvalidArg, format!("unknown action {action}")))
}

fn parse_shortcut(s: &str) -> Result<Shortcut> {
    Shortcut::parse(s).map_err(|e| Error::new(Status::InvalidArg, e.to_string()))
}

#[napi]
pub fn validate_shortcut(shortcut: String, action: String) -> Result<ShortcutValidation> {
    let s = parse_shortcut(&shortcut)?;
    let v = validate(&s, parse_action(&action)?);
    Ok(ShortcutValidation {
        normalized: s.to_string(),
        backend: match v.backend {
            Backend::Carbon => "carbon",
            Backend::EventTap => "eventTap",
        }
        .into(),
        errors: v.errors.iter().map(|e| e.to_string()).collect(),
        warnings: v.warnings.iter().map(|w| w.to_string()).collect(),
    })
}

#[napi(object)]
pub struct ShortcutConflict {
    pub a: u32,
    pub b: u32,
    /// "duplicate" | "holdPrefix"
    pub kind: String,
}

#[napi]
pub fn find_shortcut_conflicts(shortcuts: Vec<String>) -> Result<Vec<ShortcutConflict>> {
    let parsed = shortcuts.iter().map(|s| parse_shortcut(s)).collect::<Result<Vec<_>>>()?;
    Ok(find_conflicts(&parsed)
        .into_iter()
        .map(|c| ShortcutConflict {
            a: c.a as u32,
            b: c.b as u32,
            kind: match c.kind {
                ConflictKind::Duplicate => "duplicate",
                ConflictKind::HoldPrefix => "holdPrefix",
            }
            .into(),
        })
        .collect())
}

#[napi(object)]
pub struct HoldConfig {
    pub min_hold_ms: Option<u32>,
    pub double_tap_ms: Option<u32>,
    pub warn_at_ms: Option<u32>,
    pub max_session_ms: Option<u32>,
}

/// JS wrapper over the hold-to-talk state machine so Electron can drive it from real events.
#[napi]
pub struct HoldToTalk {
    machine: HoldMachine,
}

#[napi]
impl HoldToTalk {
    #[napi(constructor)]
    pub fn new(config: Option<HoldConfig>) -> Self {
        let d = Config::default();
        let c = config.unwrap_or(HoldConfig {
            min_hold_ms: None,
            double_tap_ms: None,
            warn_at_ms: None,
            max_session_ms: None,
        });
        HoldToTalk {
            machine: HoldMachine::new(Config {
                min_hold_ms: c.min_hold_ms.map_or(d.min_hold_ms, u64::from),
                double_tap_ms: c.double_tap_ms.map_or(d.double_tap_ms, u64::from),
                warn_at_ms: c.warn_at_ms.map_or(d.warn_at_ms, u64::from),
                max_session_ms: c.max_session_ms.map_or(d.max_session_ms, u64::from),
            }),
        }
    }

    /// kind: "down" | "up" | "other" | "cancel" | "tick". Returns output names such as
    /// "start", "handsFree", "warn", "stop:released", "cancel:tap".
    #[napi]
    pub fn handle(&mut self, kind: String, t_ms: f64) -> Result<Vec<String>> {
        let t = t_ms.max(0.0) as u64;
        let input = match kind.as_str() {
            "down" => Input::TriggerDown(t),
            "up" => Input::TriggerUp(t),
            "other" => Input::OtherKeyDown(t),
            "cancel" => Input::Cancel(t),
            "tick" => Input::Tick(t),
            _ => return Err(Error::new(Status::InvalidArg, format!("unknown input {kind}"))),
        };
        Ok(self.machine.handle(input).into_iter().map(output_name).collect())
    }

    #[napi(getter)]
    pub fn state(&self) -> String {
        match self.machine.state {
            State::Idle => "idle",
            State::Holding { .. } => "holding",
            State::TapPending { .. } => "tapPending",
            State::HandsFree { .. } => "handsFree",
            State::AwaitRelease => "awaitRelease",
        }
        .into()
    }
}

fn output_name(o: Output) -> String {
    match o {
        Output::StartRecording => "start".into(),
        Output::EnteredHandsFree => "handsFree".into(),
        Output::ApproachingLimit => "warn".into(),
        Output::StopAndInsert(r) => format!(
            "stop:{}",
            match r {
                StopReason::Released => "released",
                StopReason::Toggled => "toggled",
                StopReason::MaxDuration => "maxDuration",
            }
        ),
        Output::Cancel(r) => format!(
            "cancel:{}",
            match r {
                CancelReason::Tap => "tap",
                CancelReason::Chord => "chord",
                CancelReason::User => "user",
                CancelReason::TripleTap => "tripleTap",
            }
        ),
    }
}
