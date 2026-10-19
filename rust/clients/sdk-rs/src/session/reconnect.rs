//! Same-command retry across a reconnect.
//!
//! A transport end makes a session unusable, so a reconnect is a new
//! `MuseClient` plus `resume_session`, or `resume_session_with_approval_handler`
//! for a caller that answers approvals still waiting at the drop.
//! The old session's unobserved
//! submissions cross to the resumed one and are resent under their original
//! command ids, which the server answers idempotently.

use std::sync::Mutex;

use super::state::SessionState;
use super::{PendingCommandGuard, SendUserTurnOptions, Session, SessionOpening};
use crate::client::{FacadeResult, lock};
use crate::errors::{MuseError, ProtocolError};
use crate::msp::{LastTurn, TurnStartResult};
use crate::turn::Turn;

/// A `send_user_turn` submission whose outcome its session never observed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingTurn {
    pub(super) session_id: String,
    pub(super) command_id: String,
    pub(super) options: SendUserTurnOptions,
    pub(super) turn_id: Option<String>,
}

impl PendingTurn {
    /// The session the submission was sent to.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The submission's command id; [`Session::resolve_reconnect`] resends
    /// under it, so the server answers the same submission again.
    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    /// The options the submission was sent with; a resend sends them
    /// unchanged.
    pub fn options(&self) -> &SendUserTurnOptions {
        &self.options
    }

    /// The turn an answer named, or `None` when no answer arrived.
    pub fn turn_id(&self) -> Option<&str> {
        self.turn_id.as_deref()
    }
}

/// What the server's answer to one resent submission settled.
// One answer per resent submission, moved once; boxing a field would change
// the public match pattern for no measurable gain.
#[allow(clippy::large_enum_variant)]
#[non_exhaustive]
pub enum Reconnected {
    /// The answer names a turn this session follows to its terminal.
    Live(Turn),
    /// The answer names the turn the resume restated as `lastTurn`: that turn
    /// already ended, so this carries the restated terminal instead of a
    /// [`Turn`]. Events a cursor resume replays for it are not delivered here.
    Ended {
        /// The server's answer to the resend.
        ack: TurnStartResult,
        /// The ended turn as the resume restated it.
        last_turn: LastTurn,
    },
}

/// One carried submission after [`Session::resolve_reconnect`] resent it.
pub struct ReconnectResolution {
    /// The carried submission's command id.
    pub command_id: String,
    /// What the resend settled, or its error. On a durable client, of its
    /// errors only a server refusal drops this entry; any other keeps it in
    /// [`Session::pending`], and after a transport end every later entry
    /// stays there too.
    pub result: Result<Reconnected, MuseError>,
}

impl Session {
    /// Lists, in submission order, every `send_user_turn` submission whose
    /// outcome this session has not observed: no answer arrived, or the
    /// answered turn's terminal never did. Carry it to
    /// [`Session::resolve_reconnect`] on the resumed session.
    ///
    /// Unlike [`PendingCommandSet`](crate::pending::PendingCommandSet), which
    /// settles an entry on its acknowledgement, this keeps an answered
    /// submission until its turn's terminal: an answer alone is not the outcome.
    pub fn pending(&self) -> Vec<PendingTurn> {
        lock(&self.inner.state).pending_turns(&self.inner.session_id)
    }

    /// Resends carried submissions in order under their original command ids.
    ///
    /// A written intake replays its first decision instead of running twice.
    /// On a durable client, a server refusal fails only its own entry; after a
    /// transport end, that entry and every later one stay in this session's
    /// [`Session::pending`].
    /// An entry from another session refuses the whole call before any write.
    ///
    /// Once past those refusals, the call releases a resumed session's hold on
    /// settled turns when it ends, whether it succeeds or is cancelled. A call
    /// refused for a foreign entry keeps the hold for the corrected call; a
    /// discarded session refuses every call and has already dropped its settled
    /// turns. After a resume with nothing to carry, call it with an empty list
    /// to release that hold.
    pub async fn resolve_reconnect(
        &self,
        carried: Vec<PendingTurn>,
    ) -> FacadeResult<Vec<ReconnectResolution>> {
        self.inner.ensure_available()?;
        if let Some(foreign) = carried
            .iter()
            .find(|entry| entry.session_id != self.inner.session_id)
        {
            return Err(ProtocolError::new(
                format!(
                    "pending turn {} belongs to session {}, not {}",
                    foreign.command_id, foreign.session_id, self.inner.session_id
                ),
                None,
            )
            .into());
        }
        // After the refusals, which must leave the hold for a corrected call;
        // before the guards, so it drops after them on success or cancellation.
        let _release = ReleaseSettledAliasHold(&self.inner.state);
        let last_turn = match &self.inner.opening {
            SessionOpening::Resume(result) => result.last_turn.clone(),
            SessionOpening::Start(_) => None,
        };
        // Every guard lives until the last claim, so a terminal that lands
        // between two resends stays claimable as a settled alias.
        let mut guards: Vec<PendingCommandGuard> = carried
            .iter()
            .map(|entry| {
                PendingCommandGuard::begin(
                    &self.inner,
                    entry.command_id.clone(),
                    entry.options.clone(),
                )
            })
            .collect();
        let mut resolutions = Vec::with_capacity(carried.len());
        for (entry, guard) in carried.into_iter().zip(guards.iter_mut()) {
            let answer = self
                .inner
                .submit_turn(&entry.command_id, entry.options, guard)
                .await;
            let result = answer.map(|ack| match &last_turn {
                Some(last_turn) if last_turn.turn_id == ack.turn_id => {
                    lock(&self.inner.state).forget_submission(&entry.command_id);
                    Reconnected::Ended {
                        ack,
                        last_turn: last_turn.clone(),
                    }
                }
                _ => Reconnected::Live(self.inner.follow_submitted_turn(
                    &entry.command_id,
                    &ack,
                    None,
                )),
            });
            resolutions.push(ReconnectResolution {
                command_id: entry.command_id,
                result,
            });
        }
        drop(guards);
        Ok(resolutions)
    }
}

struct ReleaseSettledAliasHold<'a>(&'a Mutex<SessionState>);

impl Drop for ReleaseSettledAliasHold<'_> {
    fn drop(&mut self) {
        lock(self.0).release_settled_alias_hold();
    }
}
