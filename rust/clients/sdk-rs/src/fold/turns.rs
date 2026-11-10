//! Turn lifecycle: started/completed/retracted/unqueued, as the
//! TypeScript and Python folds apply them.

use std::collections::hash_map::Entry;

use serde_json::{Map, Value};

use super::{FoldOutcome, SessionFold, Turn, TurnState, string};

impl SessionFold {
    pub(super) fn turn_event(&mut self, method: &str, params: &Map<String, Value>) -> FoldOutcome {
        let Some(id) = string(params, "turnId") else {
            return FoldOutcome::Ignored;
        };
        let command_id = match method {
            "turn/started" | "turn/retracted" | "turn/unqueued" => {
                let Some(command_id) = string(params, "commandId") else {
                    return FoldOutcome::Ignored;
                };
                Some(command_id)
            }
            _ => None,
        };
        let terminal = if method == "turn/completed" {
            let Some(terminal) = string(params, "terminal") else {
                return FoldOutcome::Ignored;
            };
            Some(terminal)
        } else {
            None
        };
        // A declined retract means the submission stood, so the
        // fold keeps the turn's prior state, as the TypeScript and Python folds
        // do: a running turn stays running and its `turn/completed` still
        // settles it. On a turn it holds, the fold records the standing
        // submission's command id. A declined retract carries no lifecycle
        // fact, so for a turn the fold has not seen it adds no entry. Only an
        // explicit "declined" counts; any other outcome reads as accepted.
        if method == "turn/retracted" && string(params, "outcome") == Some("declined") {
            let Some(turn) = self.turns.get_mut(id) else {
                return FoldOutcome::Ignored;
            };
            turn.command_id = command_id.map(str::to_owned);
            return FoldOutcome::Applied;
        }
        let turn = match self.turns.entry(id.to_owned()) {
            Entry::Occupied(slot) => slot.into_mut(),
            Entry::Vacant(slot) => {
                self.turn_order.push(id.to_owned());
                slot.insert(Turn {
                    state: TurnState::Running,
                    command_id: None,
                    terminal: None,
                    completion: None,
                })
            }
        };
        let mut retire_prompts = false;
        match method {
            "turn/started" if turn.state == TurnState::Running => {
                let Some(command_id) = command_id else {
                    return FoldOutcome::Ignored;
                };
                turn.command_id = Some(command_id.to_owned());
                self.active_turn = Some(id.to_owned());
            }
            "turn/completed"
                if turn.terminal.is_none()
                    && !matches!(turn.state, TurnState::Retracted | TurnState::Unqueued) =>
            {
                let Some(terminal) = terminal else {
                    return FoldOutcome::Ignored;
                };
                turn.state = TurnState::Settled;
                turn.terminal = Some(terminal.to_owned());
                turn.completion = Some(Value::Object(params.clone()));
                if self.active_turn.as_deref() == Some(id) {
                    self.active_turn = None;
                }
                retire_prompts = true;
            }
            // As in the TypeScript and Python folds, an accepted retract or a
            // reclaim applies from any state: on the wire, a turn that ran and
            // was then retracted settles first and the accepted retract follows.
            // Neither is a terminal, so a terminal the turn already carries stays
            // as sent. A declined retract never reaches this arm (above).
            "turn/retracted" | "turn/unqueued" => {
                let Some(command_id) = command_id else {
                    return FoldOutcome::Ignored;
                };
                turn.command_id = Some(command_id.to_owned());
                turn.state = if method == "turn/retracted" {
                    TurnState::Retracted
                } else {
                    TurnState::Unqueued
                };
                if self.active_turn.as_deref() == Some(id) {
                    self.active_turn = None;
                }
                retire_prompts = true;
            }
            _ => return FoldOutcome::Ignored,
        }
        // A prompt listed while its turn ran retires when that turn leaves
        // `Running`: no answer can settle it afterwards, so keeping it
        // listed pends it forever (the reported started→requested→completed
        // order). A declined retract never reaches here. The scan is over
        // this session's open prompts, which stay at most a handful.
        if retire_prompts {
            self.user_inputs.retire_turn(id);
        }
        FoldOutcome::Applied
    }
}
