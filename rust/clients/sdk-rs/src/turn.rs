//! Streaming turn handle.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use tokio::sync::{mpsc, watch};

use crate::errors::{MuseError, ProtocolError};
use crate::msp::{
    Item, ItemDeltaParams, LastTurn, TurnCompletedParams, TurnErrorKind, TurnTerminal,
    TurnUnqueuedParams,
};

/// The result that settles a turn wait.
#[allow(clippy::large_enum_variant)] // Settled once per turn; a `Box` would sit in every caller's pattern.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum TurnOutcome {
    /// The turn reached its terminal (`turn/completed`).
    Completed {
        /// The `turn/completed` params.
        params: TurnCompletedParams,
        /// Whether this client saw the turn's `turn/started` notification
        /// before it completed.
        observed_start: bool,
    },
    /// The queued turn was removed before it started (`turn/unqueued`).
    Unqueued(TurnUnqueuedParams),
    /// The turn had already ended when the session resumed: the resume
    /// restates it as `lastTurn`, and no terminal for it had been applied when
    /// a same-command [`Session::send_user_turn`] retry claimed it. A terminal
    /// received before the retry's answer is applied first, unless a pending
    /// view-gap fill holds it back, and settles the retry as
    /// [`TurnOutcome::Completed`] instead; both carry the same terminal.
    ///
    /// [`Session::send_user_turn`]: crate::session::Session::send_user_turn
    Ended(LastTurn),
}

/// Returns whether the host reported a pre-start launch failure, whether the
/// turn settled on its own terminal or on the resume's `lastTurn`.
pub fn is_launch_failure(outcome: &TurnOutcome) -> bool {
    let (terminal, error) = match outcome {
        TurnOutcome::Completed { params, .. } => (&params.terminal, &params.error),
        TurnOutcome::Ended(last_turn) => (&last_turn.terminal, &last_turn.error),
        TurnOutcome::Unqueued(_) => return false,
    };
    *terminal == TurnTerminal::Failed
        && error.as_ref().map(|error| &error.kind) == Some(&TurnErrorKind::LaunchError)
}

/// Why a turn wait ended without a server-authored outcome.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum TurnWaitError {
    /// The turn's event source closed before the turn ended.
    #[error("turn event source closed before a terminal outcome")]
    SourceClosed,
    /// The client was closed before the turn ended.
    #[error("client closed before a terminal outcome")]
    ClientClosed,
    /// The turn's event source failed before the turn ended.
    #[error("turn event source failed before a terminal outcome: {message}")]
    EventSourceFailed {
        /// What failed.
        message: String,
    },
}

/// Why a turn stream could not deliver its next element.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum TurnStreamError {
    /// The turn wait ended without a server-authored outcome.
    #[error(transparent)]
    Turn(#[from] TurnWaitError),
}

/// The future returned by [`Turn::completed`].
pub type TurnOutcomeFuture =
    Pin<Box<dyn Future<Output = Result<TurnOutcome, MuseError>> + Send + 'static>>;

#[derive(Debug, Clone)]
enum TurnCompletion {
    Outcome(Box<TurnOutcome>),
    WaitFailed(TurnWaitError),
}

impl TurnCompletion {
    fn into_result(self) -> Result<TurnOutcome, MuseError> {
        match self {
            Self::Outcome(outcome) => Ok(*outcome),
            Self::WaitFailed(TurnWaitError::SourceClosed) => Err(MuseError::TransportEnded),
            Self::WaitFailed(TurnWaitError::ClientClosed) => Err(MuseError::ClientClosed),
            Self::WaitFailed(TurnWaitError::EventSourceFailed { message }) => {
                Err(ProtocolError::new(message, None).into())
            }
        }
    }
}

#[derive(Debug, Clone)]
enum StreamEvent<T> {
    Value(T),
    End,
    Failed(TurnWaitError),
}

/// A lossless stream of turn items or deltas for one active reader.
pub struct TurnStream<T: Clone> {
    replay: VecDeque<T>,
    receiver: Option<mpsc::UnboundedReceiver<StreamEvent<T>>>,
    terminal: Option<Result<(), TurnStreamError>>,
    _keepalive: Option<Arc<dyn Send + Sync>>,
}

impl<T: Clone> TurnStream<T> {
    /// The next element, or `None` once the turn has ended and every element
    /// was delivered. Errors if the turn's event source closed or failed, or
    /// the client was closed, first.
    pub async fn recv(&mut self) -> Result<Option<T>, TurnStreamError> {
        if let Some(value) = self.replay.pop_front() {
            return Ok(Some(value));
        }
        if let Some(terminal) = &self.terminal {
            return terminal.clone().map(|()| None);
        }

        let Some(receiver) = &mut self.receiver else {
            return Ok(None);
        };
        match receiver.recv().await {
            Some(StreamEvent::Value(value)) => Ok(Some(value)),
            Some(StreamEvent::End) => self.record_terminal(Ok(())),
            Some(StreamEvent::Failed(error)) => self.record_terminal(Err(error.into())),
            None => self.record_terminal(Err(TurnWaitError::SourceClosed.into())),
        }
    }

    fn record_terminal(
        &mut self,
        terminal: Result<(), TurnStreamError>,
    ) -> Result<Option<T>, TurnStreamError> {
        self.receiver = None;
        self.terminal = Some(terminal.clone());
        terminal.map(|()| None)
    }
}

struct TurnState {
    observed_start: bool,
    server_settlement: Option<Result<(), TurnWaitError>>,
    discarded_command_id: Option<String>,
    discard: Option<Weak<DiscardBinding>>,
    items: Vec<Item>,
    item_streams: Vec<mpsc::UnboundedSender<StreamEvent<Item>>>,
    delta_streams: Vec<mpsc::UnboundedSender<StreamEvent<ItemDeltaParams>>>,
}

struct TurnInner {
    turn_id: String,
    state: Mutex<TurnState>,
    outcome: watch::Sender<Option<TurnCompletion>>,
}

impl TurnInner {
    fn discard(&self, discarded: &watch::Sender<bool>, command_id: &str) -> bool {
        let mut state = lock_state(&self.state);
        if state.server_settlement.is_some() {
            return false;
        }
        state.discarded_command_id = Some(command_id.to_owned());
        discarded.send_replace(true);
        true
    }
}

struct DiscardBinding {
    inner: Weak<TurnInner>,
    command_id: String,
    discarded: watch::Sender<bool>,
}

impl DiscardBinding {
    fn discard(&self) {
        let Some(inner) = self.inner.upgrade() else {
            return;
        };
        inner.discard(&self.discarded, &self.command_id);
    }
}

impl Drop for DiscardBinding {
    fn drop(&mut self) {
        self.discard();
    }
}

/// A consumer's read-only handle to one turn.
///
/// A live handle, stream, or completion future retains the session routing
/// source needed to receive its terminal. Dropping all of them releases that
/// retention; the session-owned handle itself does not create a cycle.
#[derive(Clone)]
pub struct Turn {
    inner: Arc<TurnInner>,
    discard: Option<Arc<DiscardBinding>>,
    keepalive: Option<Arc<dyn Send + Sync>>,
}

impl Turn {
    /// The turn's id.
    pub fn turn_id(&self) -> &str {
        &self.inner.turn_id
    }

    /// Whether this client has seen the turn's `turn/started` notification.
    pub fn observed_start(&self) -> bool {
        self.lock_state().observed_start
    }

    pub(crate) fn with_discard(mut self, command_id: String) -> Self {
        let (discarded, _) = watch::channel(false);
        let discard = Arc::new(DiscardBinding {
            inner: Arc::downgrade(&self.inner),
            command_id,
            discarded,
        });
        self.lock_state().discard = Some(Arc::downgrade(&discard));
        self.discard = Some(discard);
        self
    }

    /// Resolves only from a routed terminal, or errors if that source fails.
    ///
    /// Keep this [`Turn`] alive while awaiting the returned future. Dropping
    /// the last handle discards the command locally, so an outstanding future
    /// resolves to [`MuseError::Discarded`].
    pub fn completed(&self) -> TurnOutcomeFuture {
        let mut receiver = self.inner.outcome.subscribe();
        let mut discard = self
            .discard
            .as_ref()
            .map(|discard| (discard.discarded.subscribe(), discard.command_id.clone()));
        let keepalive = self.keepalive.clone();
        Box::pin(async move {
            let _keepalive = keepalive;
            let mut discard_open = discard.is_some();
            loop {
                if let Some((discarded, command_id)) = &discard
                    && *discarded.borrow()
                {
                    return Err(MuseError::Discarded {
                        command_id: command_id.clone(),
                    });
                }
                if let Some(outcome) = receiver.borrow().clone() {
                    return outcome.into_result();
                }
                tokio::select! {
                    biased;
                    changed = async {
                        let Some((discarded, _)) = discard.as_mut() else {
                            return std::future::pending().await;
                        };
                        discarded.changed().await
                    }, if discard_open => {
                        if changed.is_err() {
                            discard_open = false;
                        }
                    }
                    changed = receiver.changed() => {
                        if changed.is_err() {
                            return Err(MuseError::TransportEnded);
                        }
                    }
                }
            }
        })
    }

    /// Replays this turn's folded items, then yields live item revisions.
    /// The stream keeps this turn's session routing source alive.
    pub fn items(&self) -> TurnStream<Item> {
        let (replay, receiver, terminal) = {
            let mut state = self.lock_state();
            let replay = state.items.clone().into();
            let (receiver, terminal) = match &state.server_settlement {
                None => {
                    let (sender, receiver) = mpsc::unbounded_channel();
                    state.item_streams.push(sender);
                    (Some(receiver), None)
                }
                Some(Ok(_)) => (None, Some(Ok(()))),
                Some(Err(error)) => (None, Some(Err(error.clone().into()))),
            };
            (replay, receiver, terminal)
        };
        TurnStream {
            replay,
            receiver,
            terminal,
            _keepalive: self.keepalive.clone(),
        }
    }

    /// Yields live deltas only; already-folded deltas are never reconstructed.
    /// The stream keeps this turn's session routing source alive.
    pub fn deltas(&self) -> TurnStream<ItemDeltaParams> {
        let mut state = self.lock_state();
        let (receiver, terminal) = match &state.server_settlement {
            None => {
                let (sender, receiver) = mpsc::unbounded_channel();
                state.delta_streams.push(sender);
                (Some(receiver), None)
            }
            Some(Ok(_)) => (None, Some(Ok(()))),
            Some(Err(error)) => (None, Some(Err(error.clone().into()))),
        };
        TurnStream {
            replay: VecDeque::new(),
            receiver,
            terminal,
            _keepalive: self.keepalive.clone(),
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, TurnState> {
        lock_state(&self.inner.state)
    }
}

/// The session-owned side of a [`Turn`].
#[derive(Clone)]
pub(crate) struct TurnHandle {
    inner: Arc<TurnInner>,
}

impl TurnHandle {
    pub(crate) fn new(turn_id: impl Into<String>) -> Self {
        let (outcome, _) = watch::channel(None);
        Self {
            inner: Arc::new(TurnInner {
                turn_id: turn_id.into(),
                state: Mutex::new(TurnState {
                    observed_start: false,
                    server_settlement: None,
                    discarded_command_id: None,
                    discard: None,
                    items: Vec::new(),
                    item_streams: Vec::new(),
                    delta_streams: Vec::new(),
                }),
                outcome,
            }),
        }
    }

    pub(crate) fn turn(&self) -> Turn {
        Turn {
            inner: Arc::clone(&self.inner),
            discard: self.discard(),
            keepalive: None,
        }
    }

    pub(crate) fn turn_with_keepalive<T>(&self, keepalive: Arc<T>) -> Turn
    where
        T: Send + Sync + 'static,
    {
        Turn {
            inner: Arc::clone(&self.inner),
            discard: self.discard(),
            keepalive: Some(keepalive),
        }
    }

    fn discard(&self) -> Option<Arc<DiscardBinding>> {
        self.lock_state().discard.as_ref().and_then(Weak::upgrade)
    }

    pub(crate) fn mark_started(&self) {
        self.lock_state().observed_start = true;
    }

    pub(crate) fn observed_start(&self) -> bool {
        self.lock_state().observed_start
    }

    pub(crate) fn is_settled(&self) -> bool {
        self.lock_state().server_settlement.is_some()
    }

    pub(crate) fn has_server_outcome(&self) -> bool {
        matches!(self.lock_state().server_settlement, Some(Ok(())))
    }

    pub(crate) fn is_command_discarded(&self, command_id: &str) -> bool {
        self.lock_state().discarded_command_id.as_deref() == Some(command_id)
    }

    pub(crate) fn discarded_command_id(&self) -> Option<String> {
        self.lock_state().discarded_command_id.clone()
    }

    /// The items this turn's stream holds, in order.
    pub(crate) fn held_items(&self) -> Vec<Item> {
        self.lock_state().items.clone()
    }

    pub(crate) fn push_item(&self, item: Item) {
        let mut state = self.lock_state();
        if state.server_settlement.is_none() {
            state.items.push(item.clone());
            state
                .item_streams
                .retain(|stream| stream.send(StreamEvent::Value(item.clone())).is_ok());
        }
    }

    pub(crate) fn push_delta(&self, delta: ItemDeltaParams) {
        let mut state = self.lock_state();
        if state.server_settlement.is_none() {
            state
                .delta_streams
                .retain(|stream| stream.send(StreamEvent::Value(delta.clone())).is_ok());
        }
    }

    pub(crate) fn settle_completed(&self, params: TurnCompletedParams) {
        self.settle(|state| {
            Ok(TurnOutcome::Completed {
                params,
                observed_start: state.observed_start,
            })
        });
    }

    pub(crate) fn settle_unqueued(&self, params: TurnUnqueuedParams) {
        self.settle(|_| Ok(TurnOutcome::Unqueued(params)));
    }

    pub(crate) fn settle_ended(&self, last_turn: LastTurn) {
        self.settle(|_| Ok(TurnOutcome::Ended(last_turn)));
    }

    pub(crate) fn fail(&self, error: TurnWaitError) {
        self.settle(|_| Err(error));
    }

    fn settle(
        &self,
        make_settlement: impl FnOnce(&TurnState) -> Result<TurnOutcome, TurnWaitError>,
    ) {
        let mut state = self.lock_state();
        if state.server_settlement.is_some() {
            return;
        }
        let settlement = make_settlement(&state);
        state.server_settlement = Some(settlement.clone().map(|_| ()));
        let completion = match &settlement {
            Ok(outcome) => TurnCompletion::Outcome(Box::new(outcome.clone())),
            Err(error) => TurnCompletion::WaitFailed(error.clone()),
        };
        self.inner.outcome.send_replace(Some(completion));
        match settlement {
            Ok(_) => {
                for stream in state.item_streams.drain(..) {
                    let _ = stream.send(StreamEvent::End);
                }
                for stream in state.delta_streams.drain(..) {
                    let _ = stream.send(StreamEvent::End);
                }
            }
            Err(error) => {
                for stream in state.item_streams.drain(..) {
                    let _ = stream.send(StreamEvent::Failed(error.clone()));
                }
                for stream in state.delta_streams.drain(..) {
                    let _ = stream.send(StreamEvent::Failed(error.clone()));
                }
            }
        }
    }

    fn lock_state(&self) -> MutexGuard<'_, TurnState> {
        lock_state(&self.inner.state)
    }
}

fn lock_state<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(state) => state,
        Err(poisoned) => poisoned.into_inner(),
    }
}

#[cfg(test)]
mod tests {
    use std::task::{Context, Poll, Waker};

    use super::*;

    /// `TurnOutcome` carries only server-authored terminals. Inside the crate the
    /// match stays exhaustive despite `#[non_exhaustive]`, so a new variant has
    /// to be added here on purpose. `Ended` carries the terminal the server's
    /// resume result restates as `lastTurn`.
    #[test]
    fn turn_outcome_contains_only_server_authored_terminals() {
        fn assert_exhaustive(outcome: TurnOutcome) {
            match outcome {
                TurnOutcome::Completed { .. }
                | TurnOutcome::Unqueued(_)
                | TurnOutcome::Ended(_) => {}
            }
        }

        let _ = assert_exhaustive;
    }

    /// A launch failure the resume restates as `lastTurn` reads the same as
    /// one carried by its own terminal.
    #[test]
    fn a_launch_failure_carried_by_ended_is_a_launch_failure() {
        let last_turn = |kind| {
            serde_json::from_value::<LastTurn>(serde_json::json!({
                "turnId": "turn-1",
                "terminal": "failed",
                "error": {"kind": kind, "message": "launch failed", "retryable": true}
            }))
        };
        let launch = last_turn("launchError");
        let other = last_turn("modelError");
        assert!(launch.is_ok() && other.is_ok(), "the fixtures decode");
        let (Ok(launch), Ok(other)) = (launch, other) else {
            return;
        };
        assert!(is_launch_failure(&TurnOutcome::Ended(launch)));
        assert!(!is_launch_failure(&TurnOutcome::Ended(other)));
    }

    fn ready<Output>(future: impl Future<Output = Output>) -> Option<Output> {
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = std::pin::pin!(future);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => Some(output),
            Poll::Pending => None,
        }
    }

    fn assert_sticky_error(mut stream: TurnStream<u8>, expected: TurnStreamError) {
        assert_eq!(ready(stream.recv()), Some(Err(expected.clone())));
        assert_eq!(ready(stream.recv()), Some(Err(expected)));
    }

    #[test]
    fn stream_terminal_errors_remain_sticky() {
        let source_failure = TurnWaitError::EventSourceFailed {
            message: "connection lost".to_owned(),
        };
        let (failed_sender, failed_receiver) = mpsc::unbounded_channel();
        assert!(
            failed_sender
                .send(StreamEvent::Failed(source_failure.clone()))
                .is_ok(),
            "the stream receiver is active"
        );
        assert_sticky_error(
            TurnStream {
                replay: VecDeque::new(),
                receiver: Some(failed_receiver),
                terminal: None,
                _keepalive: None,
            },
            TurnStreamError::Turn(source_failure),
        );

        let (closed_sender, closed_receiver) = mpsc::unbounded_channel();
        drop(closed_sender);
        assert_sticky_error(
            TurnStream {
                replay: VecDeque::new(),
                receiver: Some(closed_receiver),
                terminal: None,
                _keepalive: None,
            },
            TurnStreamError::Turn(TurnWaitError::SourceClosed),
        );
    }

    #[test]
    fn item_replay_is_independent_for_each_reader() -> Result<(), serde_json::Error> {
        let handle = TurnHandle::new("turn-1");
        let item: Item = serde_json::from_value(serde_json::json!({
            "itemId": "item-1",
            "kind": "agentMessage",
            "turnId": "turn-1",
            "revision": 1,
            "status": "completed",
            "text": "hello"
        }))?;
        handle.push_item(item.clone());

        let mut first = handle.turn().items();
        let mut second = handle.turn().items();
        assert_eq!(ready(first.recv()), Some(Ok(Some(item.clone()))));
        assert_eq!(ready(second.recv()), Some(Ok(Some(item))));
        Ok(())
    }

    #[test]
    fn readers_can_join_late_and_replay_after_completion() -> Result<(), serde_json::Error> {
        let handle = TurnHandle::new("turn-1");
        let first: Item = serde_json::from_value(serde_json::json!({
            "itemId": "item-1",
            "kind": "agentMessage",
            "turnId": "turn-1",
            "revision": 1,
            "status": "completed",
            "text": "first"
        }))?;
        let second: Item = serde_json::from_value(serde_json::json!({
            "itemId": "item-2",
            "kind": "agentMessage",
            "turnId": "turn-1",
            "revision": 1,
            "status": "completed",
            "text": "second"
        }))?;
        handle.push_item(first.clone());
        let mut early = handle.turn().items();
        handle.push_item(second.clone());
        handle.fail(TurnWaitError::EventSourceFailed {
            message: "terminal test failure".to_owned(),
        });

        assert_eq!(ready(early.recv()), Some(Ok(Some(first.clone()))));
        assert_eq!(ready(early.recv()), Some(Ok(Some(second.clone()))));
        assert!(matches!(
            ready(early.recv()),
            Some(Err(TurnStreamError::Turn(
                TurnWaitError::EventSourceFailed { .. }
            )))
        ));

        let mut late = handle.turn().items();
        assert_eq!(ready(late.recv()), Some(Ok(Some(first))));
        assert_eq!(ready(late.recv()), Some(Ok(Some(second))));
        assert!(matches!(
            ready(late.recv()),
            Some(Err(TurnStreamError::Turn(
                TurnWaitError::EventSourceFailed { .. }
            )))
        ));
        Ok(())
    }
}
