//! Shortcut parsing, validation and conflict detection (macOS key model).
//!
//! A shortcut is a set of modifiers plus at most one key. Validation also decides which
//! macOS backend can deliver it:
//! - `Carbon` (`RegisterEventHotKey`): needs no permission, delivers press and release, but only
//!   for modifier+key combos.
//! - `EventTap` (`CGEventTap`, listen-only): needs Input Monitoring; required for modifier-only
//!   shortcuts (e.g. Right Option, Fn, Ctrl+Opt).

use std::fmt;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Mods(u8);

impl Mods {
    pub const CMD: Mods = Mods(1);
    pub const CTRL: Mods = Mods(2);
    pub const OPT: Mods = Mods(4);
    pub const SHIFT: Mods = Mods(8);
    pub const FN: Mods = Mods(16);

    pub fn empty() -> Mods {
        Mods(0)
    }
    pub fn contains(self, other: Mods) -> bool {
        self.0 & other.0 == other.0
    }
    pub fn insert(&mut self, other: Mods) {
        self.0 |= other.0;
    }
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
    pub fn count(self) -> u32 {
        self.0.count_ones()
    }
    pub fn bits(self) -> u8 {
        self.0
    }
    /// Carbon `RegisterEventHotKey` modifier mask (cmdKey, shiftKey, optionKey, controlKey).
    pub fn carbon_mask(self) -> u32 {
        let mut m = 0;
        if self.contains(Mods::CMD) {
            m |= 1 << 8;
        }
        if self.contains(Mods::SHIFT) {
            m |= 1 << 9;
        }
        if self.contains(Mods::OPT) {
            m |= 1 << 11;
        }
        if self.contains(Mods::CTRL) {
            m |= 1 << 12;
        }
        m
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum KeyKind {
    Character,
    Space,
    Escape,
    Navigation,
    Function,
    /// A modifier key used on its own, e.g. Right Option.
    SidedModifier,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Key {
    pub name: &'static str,
    /// macOS virtual keycode (kVK_*).
    pub keycode: u16,
    pub kind: KeyKind,
}

const KEYS: &[(&str, u16, KeyKind)] = &[
    ("a", 0, KeyKind::Character),
    ("s", 1, KeyKind::Character),
    ("d", 2, KeyKind::Character),
    ("f", 3, KeyKind::Character),
    ("h", 4, KeyKind::Character),
    ("g", 5, KeyKind::Character),
    ("z", 6, KeyKind::Character),
    ("x", 7, KeyKind::Character),
    ("c", 8, KeyKind::Character),
    ("v", 9, KeyKind::Character),
    ("b", 11, KeyKind::Character),
    ("q", 12, KeyKind::Character),
    ("w", 13, KeyKind::Character),
    ("e", 14, KeyKind::Character),
    ("r", 15, KeyKind::Character),
    ("y", 16, KeyKind::Character),
    ("t", 17, KeyKind::Character),
    ("1", 18, KeyKind::Character),
    ("2", 19, KeyKind::Character),
    ("3", 20, KeyKind::Character),
    ("4", 21, KeyKind::Character),
    ("6", 22, KeyKind::Character),
    ("5", 23, KeyKind::Character),
    ("9", 25, KeyKind::Character),
    ("7", 26, KeyKind::Character),
    ("8", 28, KeyKind::Character),
    ("0", 29, KeyKind::Character),
    ("o", 31, KeyKind::Character),
    ("u", 32, KeyKind::Character),
    ("i", 34, KeyKind::Character),
    ("p", 35, KeyKind::Character),
    ("l", 37, KeyKind::Character),
    ("j", 38, KeyKind::Character),
    ("k", 40, KeyKind::Character),
    ("n", 45, KeyKind::Character),
    ("m", 46, KeyKind::Character),
    ("tab", 48, KeyKind::Navigation),
    ("return", 36, KeyKind::Navigation),
    ("space", 49, KeyKind::Space),
    ("escape", 53, KeyKind::Escape),
    ("left", 123, KeyKind::Navigation),
    ("right", 124, KeyKind::Navigation),
    ("down", 125, KeyKind::Navigation),
    ("up", 126, KeyKind::Navigation),
    ("f1", 122, KeyKind::Function),
    ("f2", 120, KeyKind::Function),
    ("f3", 99, KeyKind::Function),
    ("f4", 118, KeyKind::Function),
    ("f5", 96, KeyKind::Function),
    ("f6", 97, KeyKind::Function),
    ("f7", 98, KeyKind::Function),
    ("f8", 100, KeyKind::Function),
    ("f9", 101, KeyKind::Function),
    ("f10", 109, KeyKind::Function),
    ("f11", 103, KeyKind::Function),
    ("f12", 111, KeyKind::Function),
    ("f13", 105, KeyKind::Function),
    ("f14", 107, KeyKind::Function),
    ("f15", 113, KeyKind::Function),
    ("f16", 106, KeyKind::Function),
    ("f17", 64, KeyKind::Function),
    ("f18", 79, KeyKind::Function),
    ("f19", 80, KeyKind::Function),
    ("rightoption", 61, KeyKind::SidedModifier),
    ("rightcommand", 54, KeyKind::SidedModifier),
    ("rightcontrol", 62, KeyKind::SidedModifier),
    ("rightshift", 60, KeyKind::SidedModifier),
];

fn key_alias(token: &str) -> &str {
    match token {
        "esc" => "escape",
        "enter" => "return",
        "ropt" | "rightalt" | "ralt" => "rightoption",
        "rcmd" => "rightcommand",
        "rctrl" => "rightcontrol",
        other => other,
    }
}

pub fn key_by_name(name: &str) -> Option<Key> {
    let name = key_alias(name);
    KEYS.iter()
        .find(|(n, _, _)| *n == name)
        .map(|&(name, keycode, kind)| Key {
            name,
            keycode,
            kind,
        })
}

pub fn key_by_code(keycode: u16) -> Option<Key> {
    KEYS.iter()
        .find(|(_, c, _)| *c == keycode)
        .map(|&(name, keycode, kind)| Key {
            name,
            keycode,
            kind,
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Shortcut {
    pub mods: Mods,
    pub key: Option<Key>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseError {
    Empty,
    UnknownToken(String),
    MultipleKeys,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ParseError::Empty => write!(f, "empty shortcut"),
            ParseError::UnknownToken(t) => write!(f, "unknown key '{t}'"),
            ParseError::MultipleKeys => write!(f, "only one non-modifier key is allowed"),
        }
    }
}

impl Shortcut {
    pub fn parse(input: &str) -> Result<Shortcut, ParseError> {
        let mut mods = Mods::empty();
        let mut key = None;
        let tokens: Vec<String> = input
            .split('+')
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        if tokens.is_empty() {
            return Err(ParseError::Empty);
        }
        for token in tokens {
            let modifier = match token.as_str() {
                "cmd" | "command" | "⌘" => Some(Mods::CMD),
                "ctrl" | "control" | "⌃" => Some(Mods::CTRL),
                "opt" | "option" | "alt" | "⌥" => Some(Mods::OPT),
                "shift" | "⇧" => Some(Mods::SHIFT),
                "fn" | "globe" => Some(Mods::FN),
                _ => None,
            };
            if let Some(m) = modifier {
                mods.insert(m);
                continue;
            }
            let k = key_by_name(&token).ok_or(ParseError::UnknownToken(token))?;
            if key.replace(k).is_some() {
                return Err(ParseError::MultipleKeys);
            }
        }
        Ok(Shortcut { mods, key })
    }

    pub fn key_count(&self) -> u32 {
        self.mods.count() + u32::from(self.key.is_some())
    }

    pub fn is_modifier_only(&self) -> bool {
        match self.key {
            None => true,
            Some(k) => k.kind == KeyKind::SidedModifier,
        }
    }

    /// True when every key in `self` is also in `other` and `other` has more keys.
    pub fn is_strict_subset_of(&self, other: &Shortcut) -> bool {
        let mods_subset = other.mods.contains(self.mods);
        let key_subset = match (self.key, other.key) {
            (None, _) => true,
            (Some(a), Some(b)) => a == b,
            (Some(_), None) => false,
        };
        mods_subset && key_subset && self.key_count() < other.key_count()
    }
}

impl fmt::Display for Shortcut {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut parts = Vec::new();
        for (m, name) in [
            (Mods::FN, "Fn"),
            (Mods::CTRL, "Ctrl"),
            (Mods::OPT, "Opt"),
            (Mods::SHIFT, "Shift"),
            (Mods::CMD, "Cmd"),
        ] {
            if self.mods.contains(m) {
                parts.push(name.to_string());
            }
        }
        if let Some(k) = self.key {
            parts.push(k.name.to_string());
        }
        write!(f, "{}", parts.join("+"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    PushToTalk,
    HandsFree,
    Cancel,
    PasteLast,
}

impl Action {
    pub fn parse(s: &str) -> Option<Action> {
        match s {
            "pushToTalk" => Some(Action::PushToTalk),
            "handsFree" => Some(Action::HandsFree),
            "cancel" => Some(Action::Cancel),
            "pasteLast" => Some(Action::PasteLast),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Backend {
    /// RegisterEventHotKey — no permission required.
    Carbon,
    /// Listen-only CGEventTap — requires Input Monitoring.
    EventTap,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Validation {
    pub backend: Backend,
    pub errors: Vec<&'static str>,
    pub warnings: Vec<&'static str>,
}

/// Combos macOS or nearly every app already owns. Binding them would break the user's system.
const RESERVED: &[(&str, &str)] = &[
    ("Cmd+space", "spotlight"),
    ("Ctrl+space", "input-source-switch"),
    ("Opt+Cmd+space", "finder-search"),
    ("Cmd+tab", "app-switcher"),
    ("Cmd+q", "quit"),
    ("Cmd+w", "close-window"),
    ("Cmd+h", "hide"),
    ("Cmd+m", "minimize"),
    ("Cmd+c", "copy"),
    ("Cmd+v", "paste"),
    ("Cmd+x", "cut"),
    ("Cmd+z", "undo"),
    ("Cmd+a", "select-all"),
    ("Cmd+s", "save"),
    ("Shift+Cmd+3", "screenshot"),
    ("Shift+Cmd+4", "screenshot"),
    ("Shift+Cmd+5", "screenshot"),
    ("Opt+Cmd+escape", "force-quit"),
    ("Ctrl+Cmd+q", "lock-screen"),
    ("Ctrl+Cmd+f", "full-screen"),
    ("Ctrl+up", "mission-control"),
    ("Ctrl+down", "app-expose"),
    ("Ctrl+left", "switch-space"),
    ("Ctrl+right", "switch-space"),
];

pub fn reserved_reason(s: &Shortcut) -> Option<&'static str> {
    let display = s.to_string();
    RESERVED
        .iter()
        .find(|(combo, _)| Shortcut::parse(combo).map(|r| r.to_string()).as_deref() == Ok(&display))
        .map(|(_, reason)| *reason)
}

/// A single Control or Command plus a printable key belongs to the focused app: Control+letter is
/// the Emacs editing set in every Cocoa text field and a control character in Terminal; Command
/// +letter/number is the menu shortcut of nearly every app. A global hot key would steal it
/// everywhere.
pub fn shared_with_apps(s: &Shortcut) -> Option<&'static str> {
    if !matches!(s.key.map(|k| k.kind), Some(KeyKind::Character)) {
        return None;
    }
    if s.mods == Mods::CTRL {
        Some("control-letter-used-by-text-editing")
    } else if s.mods == Mods::CMD {
        Some("command-letter-used-by-apps")
    } else {
        None
    }
}

pub fn validate(s: &Shortcut, action: Action) -> Validation {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if s.key_count() == 0 {
        errors.push("empty");
    }
    if s.key_count() > 3 {
        errors.push("too-many-keys");
    }
    match s.key {
        Some(k) if k.kind == KeyKind::SidedModifier && !s.mods.is_empty() => {
            errors.push("sided-modifier-must-be-alone")
        }
        Some(k)
            if s.mods.is_empty()
                && matches!(
                    k.kind,
                    KeyKind::Character | KeyKind::Space | KeyKind::Navigation
                ) =>
        {
            errors.push("needs-modifier")
        }
        Some(k) if k.kind == KeyKind::Escape && s.mods.is_empty() && action != Action::Cancel => {
            errors.push("escape-alone-reserved-for-cancel")
        }
        Some(k) if k.kind == KeyKind::Function && s.mods.is_empty() => {
            if !matches!(k.name, "f13" | "f14" | "f15" | "f16" | "f17" | "f18" | "f19") {
                warnings.push("function-key-may-be-media-key");
            }
        }
        _ => {}
    }
    if s.mods == Mods::SHIFT && matches!(s.key.map(|k| k.kind), Some(KeyKind::Character)) {
        errors.push("shift-only-blocks-typing");
    }
    if s.key.is_none() && s.mods == Mods::SHIFT {
        errors.push("shift-alone-blocks-typing");
    }
    if s.key.is_none() && (s.mods == Mods::CMD || s.mods == Mods::CTRL || s.mods == Mods::OPT) {
        errors.push("single-left-modifier-too-common");
    }
    if reserved_reason(s).is_some() {
        errors.push("system-reserved");
    }
    if let Some(code) = shared_with_apps(s) {
        errors.push(code);
    }
    if s.is_modifier_only() && action != Action::PushToTalk && action != Action::HandsFree {
        errors.push("modifier-only-requires-hold-action");
    }

    let needs_tap = s.is_modifier_only() || s.mods.contains(Mods::FN);
    let option_shift_only = !s.mods.is_empty()
        && !s.mods.contains(Mods::CMD)
        && !s.mods.contains(Mods::CTRL)
        && !s.mods.contains(Mods::FN);
    let backend = if needs_tap {
        Backend::EventTap
    } else if option_shift_only {
        // macOS 15+ reportedly stops delivering Carbon hot keys whose modifiers are only
        // Option/Shift. On macOS 27 registration still succeeds (M0 measurement), but delivery
        // is unverified, so these stay on the event tap until a manual test confirms otherwise.
        warnings.push("option-shift-only-needs-event-tap");
        Backend::EventTap
    } else {
        Backend::Carbon
    };
    if backend == Backend::EventTap {
        warnings.push("requires-input-monitoring");
    }

    Validation {
        backend,
        errors,
        warnings,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConflictKind {
    /// Two actions bound to the same keys. Error.
    Duplicate,
    /// A modifier-only hold shortcut is contained in another shortcut, so pressing the longer one
    /// starts the hold first. Resolved at runtime by cancelling on chord, but worth a warning.
    HoldPrefix,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Conflict {
    pub a: usize,
    pub b: usize,
    pub kind: ConflictKind,
}

pub fn find_conflicts(bindings: &[Shortcut]) -> Vec<Conflict> {
    let mut out = Vec::new();
    for i in 0..bindings.len() {
        for j in (i + 1)..bindings.len() {
            let (a, b) = (&bindings[i], &bindings[j]);
            if a == b {
                out.push(Conflict {
                    a: i,
                    b: j,
                    kind: ConflictKind::Duplicate,
                });
            } else if (a.is_modifier_only() && a.is_strict_subset_of(b))
                || (b.is_modifier_only() && b.is_strict_subset_of(a))
            {
                out.push(Conflict {
                    a: i,
                    b: j,
                    kind: ConflictKind::HoldPrefix,
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(s: &str) -> Shortcut {
        Shortcut::parse(s).unwrap()
    }

    #[test]
    fn parses_aliases_and_normalizes_display() {
        assert_eq!(p("control + option + SPACE").to_string(), "Ctrl+Opt+space");
        assert_eq!(p("⌘+⇧+k").to_string(), "Shift+Cmd+k");
        assert_eq!(p("ropt").key.unwrap().keycode, 61);
        assert_eq!(p("esc").key.unwrap().name, "escape");
    }

    #[test]
    fn single_control_or_command_with_a_printable_key_is_refused() {
        let errors = |s: &str| validate(&p(s), Action::PasteLast).errors;
        for s in ["ctrl+a", "ctrl+e", "ctrl+r", "ctrl+1"] {
            assert!(
                errors(s).contains(&"control-letter-used-by-text-editing"),
                "{s}"
            );
        }
        for s in ["cmd+b", "cmd+f", "cmd+1"] {
            assert!(errors(s).contains(&"command-letter-used-by-apps"), "{s}");
        }
    }

    #[test]
    fn other_combinations_keep_their_rules() {
        let errors = |s: &str| validate(&p(s), Action::PasteLast).errors;
        for s in [
            "ctrl+opt+space",
            "ctrl+opt+1",
            "ctrl+opt+2",
            "ctrl+shift+a",
            "ctrl+cmd+9",
            "opt+cmd+b",
            "ctrl+opt+f9",
            "ctrl+opt+f12",
            "ctrl+space",
            "ctrl+f5",
            "cmd+f5",
            "ctrl+tab",
            "ctrl+return",
        ] {
            let e = errors(s);
            assert!(
                !e.contains(&"control-letter-used-by-text-editing")
                    && !e.contains(&"command-letter-used-by-apps"),
                "{s}"
            );
        }
        assert!(errors("ctrl+opt+space").is_empty());
    }

    #[test]
    fn rejects_unknown_and_multiple_keys() {
        assert_eq!(
            Shortcut::parse("ctrl+banana"),
            Err(ParseError::UnknownToken("banana".into()))
        );
        assert_eq!(Shortcut::parse("ctrl+a+b"), Err(ParseError::MultipleKeys));
        assert_eq!(Shortcut::parse(" + "), Err(ParseError::Empty));
    }

    #[test]
    fn carbon_mask_matches_carbon_constants() {
        assert_eq!(p("cmd+a").mods.carbon_mask(), 256);
        assert_eq!(p("ctrl+opt+cmd+a").mods.carbon_mask(), 256 | 2048 | 4096);
        assert_eq!(p("shift+ctrl+a").mods.carbon_mask(), 512 | 4096);
    }

    #[test]
    fn modifier_only_and_fn_need_event_tap() {
        let v = validate(&p("rightoption"), Action::PushToTalk);
        assert!(v.errors.is_empty(), "{:?}", v.errors);
        assert_eq!(v.backend, Backend::EventTap);
        assert_eq!(validate(&p("ctrl+opt"), Action::PushToTalk).backend, Backend::EventTap);
        assert_eq!(validate(&p("fn"), Action::PushToTalk).backend, Backend::EventTap);
        assert_eq!(validate(&p("fn+space"), Action::HandsFree).backend, Backend::EventTap);
    }

    #[test]
    fn ctrl_or_cmd_combos_use_carbon() {
        let v = validate(&p("ctrl+opt+space"), Action::HandsFree);
        assert!(v.errors.is_empty());
        assert_eq!(v.backend, Backend::Carbon);
        assert!(v.warnings.is_empty());
    }

    #[test]
    fn option_shift_only_combos_are_routed_to_event_tap() {
        let v = validate(&p("opt+k"), Action::PushToTalk);
        assert_eq!(v.backend, Backend::EventTap);
        assert!(v.warnings.contains(&"option-shift-only-needs-event-tap"));
    }

    #[test]
    fn rejects_unsafe_bindings() {
        let errs = |s: &str, a| validate(&p(s), a).errors;
        assert!(errs("k", Action::PushToTalk).contains(&"needs-modifier"));
        assert!(errs("space", Action::PushToTalk).contains(&"needs-modifier"));
        assert!(errs("shift+k", Action::PushToTalk).contains(&"shift-only-blocks-typing"));
        assert!(errs("cmd+space", Action::PushToTalk).contains(&"system-reserved"));
        assert!(errs("cmd+v", Action::PasteLast).contains(&"system-reserved"));
        assert!(errs("ctrl+space", Action::HandsFree).contains(&"system-reserved"));
        assert!(errs("escape", Action::PushToTalk).contains(&"escape-alone-reserved-for-cancel"));
        assert!(errs("escape", Action::Cancel).is_empty());
        assert!(errs("cmd", Action::PushToTalk).contains(&"single-left-modifier-too-common"));
        assert!(errs("ctrl+opt+shift+cmd", Action::PushToTalk).contains(&"too-many-keys"));
        assert!(errs("ctrl+rightoption", Action::PushToTalk).contains(&"sided-modifier-must-be-alone"));
        assert!(errs("rightoption", Action::PasteLast).contains(&"modifier-only-requires-hold-action"));
    }

    #[test]
    fn f13_alone_is_allowed_without_warning() {
        let v = validate(&p("f13"), Action::PushToTalk);
        assert!(v.errors.is_empty());
        assert!(!v.warnings.contains(&"function-key-may-be-media-key"));
        assert!(validate(&p("f5"), Action::PushToTalk)
            .warnings
            .contains(&"function-key-may-be-media-key"));
    }

    #[test]
    fn finds_duplicates_and_hold_prefixes() {
        let bindings = [p("ctrl+opt"), p("ctrl+opt+space"), p("cmd+shift+k"), p("shift+cmd+k")];
        let c = find_conflicts(&bindings);
        assert_eq!(
            c,
            vec![
                Conflict { a: 0, b: 1, kind: ConflictKind::HoldPrefix },
                Conflict { a: 2, b: 3, kind: ConflictKind::Duplicate },
            ]
        );
    }

    #[test]
    fn key_combos_with_distinct_modifiers_do_not_conflict() {
        // Carbon and our tap both match modifiers exactly, so Ctrl+K never fires for Ctrl+Shift+K.
        assert!(find_conflicts(&[p("ctrl+k"), p("ctrl+shift+k")]).is_empty());
    }
}
