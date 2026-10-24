//! Hold-to-talk / hands-free state machine.
//!
//! Recording starts on the first key-down so the first word is never lost. A press shorter
//! than `min_hold_ms` is a tap: if a second press follows within `double_tap_ms` the session
//! becomes hands-free, otherwise it is cancelled. All time values are milliseconds from any
//! monotonic clock supplied by the caller, which keeps this module deterministic and testable.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub min_hold_ms: u64,
    pub double_tap_ms: u64,
    pub warn_at_ms: u64,
    pub max_session_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            min_hold_ms: 300,
            double_tap_ms: 400,
            warn_at_ms: 19 * 60 * 1000,
            max_session_ms: 20 * 60 * 1000,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    TriggerDown(u64),
    TriggerUp(u64),
    /// Any non-trigger key pressed (used to detect the trigger being part of another chord).
    OtherKeyDown(u64),
    /// Explicit cancel (Esc or the capsule's cancel button).
    Cancel(u64),
    Tick(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    Released,
    Toggled,
    MaxDuration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    Tap,
    Chord,
    User,
    TripleTap,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Output {
    StartRecording,
    EnteredHandsFree,
    ApproachingLimit,
    StopAndInsert(StopReason),
    Cancel(CancelReason),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Idle,
    Holding { start: u64, warned: bool },
    TapPending { start: u64, released: u64 },
    HandsFree { start: u64, entered: u64, trigger_down: bool, warned: bool },
    /// Session ended while the trigger is still physically down; swallow its release.
    AwaitRelease,
}

#[derive(Debug)]
pub struct HoldMachine {
    pub config: Config,
    pub state: State,
}

impl HoldMachine {
    pub fn new(config: Config) -> Self {
        HoldMachine {
            config,
            state: State::Idle,
        }
    }

    pub fn is_recording(&self) -> bool {
        matches!(
            self.state,
            State::Holding { .. } | State::TapPending { .. } | State::HandsFree { .. }
        )
    }

    pub fn handle(&mut self, input: Input) -> Vec<Output> {
        let c = self.config;
        let (next, out) = match (self.state, input) {
            (_, Input::Cancel(_)) if self.is_recording() => {
                (State::Idle, vec![Output::Cancel(CancelReason::User)])
            }

            (State::Idle, Input::TriggerDown(t)) => (
                State::Holding {
                    start: t,
                    warned: false,
                },
                vec![Output::StartRecording],
            ),

            (State::Holding { start, .. }, Input::TriggerUp(t)) => {
                if t.saturating_sub(start) >= c.min_hold_ms {
                    (
                        State::Idle,
                        vec![Output::StopAndInsert(StopReason::Released)],
                    )
                } else {
                    (State::TapPending { start, released: t }, vec![])
                }
            }
            (State::Holding { start, .. }, Input::OtherKeyDown(t))
                if t.saturating_sub(start) < c.min_hold_ms =>
            {
                (State::Idle, vec![Output::Cancel(CancelReason::Chord)])
            }
            (State::Holding { start, warned }, Input::Tick(t)) => {
                let elapsed = t.saturating_sub(start);
                if elapsed >= c.max_session_ms {
                    (
                        State::AwaitRelease,
                        vec![Output::StopAndInsert(StopReason::MaxDuration)],
                    )
                } else if elapsed >= c.warn_at_ms && !warned {
                    (
                        State::Holding {
                            start,
                            warned: true,
                        },
                        vec![Output::ApproachingLimit],
                    )
                } else {
                    (self.state, vec![])
                }
            }

            (State::TapPending { start, released }, Input::TriggerDown(t)) => {
                if t.saturating_sub(released) <= c.double_tap_ms {
                    (
                        State::HandsFree {
                            start,
                            entered: t,
                            trigger_down: true,
                            warned: false,
                        },
                        vec![Output::EnteredHandsFree],
                    )
                } else {
                    (
                        State::Holding {
                            start: t,
                            warned: false,
                        },
                        vec![
                            Output::Cancel(CancelReason::Tap),
                            Output::StartRecording,
                        ],
                    )
                }
            }
            (State::TapPending { released, .. }, Input::Tick(t))
                if t.saturating_sub(released) > c.double_tap_ms =>
            {
                (State::Idle, vec![Output::Cancel(CancelReason::Tap)])
            }
            (State::TapPending { .. }, Input::OtherKeyDown(_)) => {
                (State::Idle, vec![Output::Cancel(CancelReason::Tap)])
            }

            (
                State::HandsFree {
                    start,
                    entered,
                    warned,
                    ..
                },
                Input::TriggerUp(_),
            ) => (
                State::HandsFree {
                    start,
                    entered,
                    trigger_down: false,
                    warned,
                },
                vec![],
            ),
            (State::HandsFree { entered, .. }, Input::TriggerDown(t)) => {
                if t.saturating_sub(entered) <= c.double_tap_ms {
                    (
                        State::AwaitRelease,
                        vec![Output::Cancel(CancelReason::TripleTap)],
                    )
                } else {
                    (
                        State::AwaitRelease,
                        vec![Output::StopAndInsert(StopReason::Toggled)],
                    )
                }
            }
            (
                State::HandsFree {
                    start,
                    entered,
                    trigger_down,
                    warned,
                },
                Input::Tick(t),
            ) => {
                let elapsed = t.saturating_sub(start);
                if elapsed >= c.max_session_ms {
                    let next = if trigger_down {
                        State::AwaitRelease
                    } else {
                        State::Idle
                    };
                    (next, vec![Output::StopAndInsert(StopReason::MaxDuration)])
                } else if elapsed >= c.warn_at_ms && !warned {
                    (
                        State::HandsFree {
                            start,
                            entered,
                            trigger_down,
                            warned: true,
                        },
                        vec![Output::ApproachingLimit],
                    )
                } else {
                    (self.state, vec![])
                }
            }

            (State::AwaitRelease, Input::TriggerUp(_)) => (State::Idle, vec![]),
            (State::AwaitRelease, Input::Cancel(_)) => (State::Idle, vec![]),

            (state, _) => (state, vec![]),
        };
        self.state = next;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Input::*;

    fn run(inputs: &[Input]) -> (Vec<Output>, State) {
        let mut m = HoldMachine::new(Config::default());
        let mut all = Vec::new();
        for i in inputs {
            all.extend(m.handle(*i));
        }
        (all, m.state)
    }

    #[test]
    fn hold_and_release_inserts() {
        let (out, state) = run(&[TriggerDown(0), TriggerUp(1200)]);
        assert_eq!(
            out,
            vec![
                Output::StartRecording,
                Output::StopAndInsert(StopReason::Released)
            ]
        );
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn short_tap_is_cancelled_after_double_tap_window() {
        let (out, state) = run(&[TriggerDown(0), TriggerUp(120), Tick(400), Tick(600)]);
        assert_eq!(
            out,
            vec![Output::StartRecording, Output::Cancel(CancelReason::Tap)]
        );
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn exactly_min_hold_counts_as_hold() {
        let (out, _) = run(&[TriggerDown(0), TriggerUp(300)]);
        assert_eq!(out[1], Output::StopAndInsert(StopReason::Released));
    }

    #[test]
    fn double_tap_enters_hands_free_and_next_press_stops() {
        let (out, state) = run(&[
            TriggerDown(0),
            TriggerUp(100),
            TriggerDown(300),
            TriggerUp(380),
            Tick(5_000),
            TriggerDown(9_000),
            TriggerUp(9_100),
        ]);
        assert_eq!(
            out,
            vec![
                Output::StartRecording,
                Output::EnteredHandsFree,
                Output::StopAndInsert(StopReason::Toggled)
            ]
        );
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn triple_tap_cancels() {
        let (out, state) = run(&[
            TriggerDown(0),
            TriggerUp(80),
            TriggerDown(200),
            TriggerUp(260),
            TriggerDown(400),
            TriggerUp(450),
        ]);
        assert_eq!(*out.last().unwrap(), Output::Cancel(CancelReason::TripleTap));
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn late_second_press_starts_a_new_hold() {
        // No tick arrived between presses (e.g. a stalled timer), so the late press resolves both.
        let (out, state) = run(&[TriggerDown(0), TriggerUp(100), TriggerDown(900)]);
        assert_eq!(
            out,
            vec![
                Output::StartRecording,
                Output::Cancel(CancelReason::Tap),
                Output::StartRecording
            ]
        );
        assert!(matches!(state, State::Holding { start: 900, .. }));
    }

    #[test]
    fn chord_during_early_hold_cancels() {
        // User holds Ctrl+Opt (our trigger) but presses another key: they meant a different shortcut.
        let (out, state) = run(&[TriggerDown(0), OtherKeyDown(80)]);
        assert_eq!(
            out,
            vec![Output::StartRecording, Output::Cancel(CancelReason::Chord)]
        );
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn other_key_after_min_hold_is_ignored() {
        let (out, _) = run(&[TriggerDown(0), OtherKeyDown(1_000), TriggerUp(2_000)]);
        assert_eq!(out[1], Output::StopAndInsert(StopReason::Released));
    }

    #[test]
    fn escape_cancels_hold_and_hands_free() {
        let (out, _) = run(&[TriggerDown(0), Cancel(500)]);
        assert_eq!(out[1], Output::Cancel(CancelReason::User));
        let (out, state) = run(&[
            TriggerDown(0),
            TriggerUp(50),
            TriggerDown(200),
            TriggerUp(250),
            Cancel(3_000),
        ]);
        assert_eq!(*out.last().unwrap(), Output::Cancel(CancelReason::User));
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn cancel_while_idle_is_a_no_op() {
        let (out, state) = run(&[Cancel(0)]);
        assert!(out.is_empty());
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn warns_once_then_stops_at_max_duration_and_swallows_release() {
        let c = Config::default();
        let (out, state) = run(&[
            TriggerDown(0),
            Tick(c.warn_at_ms),
            Tick(c.warn_at_ms + 1_000),
            Tick(c.max_session_ms),
        ]);
        assert_eq!(
            out,
            vec![
                Output::StartRecording,
                Output::ApproachingLimit,
                Output::StopAndInsert(StopReason::MaxDuration)
            ]
        );
        assert_eq!(state, State::AwaitRelease);
        let mut m = HoldMachine::new(c);
        m.state = state;
        assert!(m.handle(TriggerUp(c.max_session_ms + 10)).is_empty());
        assert_eq!(m.state, State::Idle);
    }

    #[test]
    fn hands_free_max_duration_returns_to_idle_when_key_is_up() {
        let c = Config::default();
        let (out, state) = run(&[
            TriggerDown(0),
            TriggerUp(50),
            TriggerDown(200),
            TriggerUp(260),
            Tick(c.max_session_ms),
        ]);
        assert_eq!(*out.last().unwrap(), Output::StopAndInsert(StopReason::MaxDuration));
        assert_eq!(state, State::Idle);
    }

    #[test]
    fn key_repeat_downs_while_holding_are_ignored() {
        let (out, _) = run(&[TriggerDown(0), TriggerDown(500), TriggerDown(530), TriggerUp(900)]);
        assert_eq!(
            out,
            vec![
                Output::StartRecording,
                Output::StopAndInsert(StopReason::Released)
            ]
        );
    }
}
