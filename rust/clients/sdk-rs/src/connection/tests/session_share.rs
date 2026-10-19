//! Under contention, a session holding its share of the
//! handoff pool fails first, on its own frame.

use super::*;

const SHARE: usize = 256;

struct Handoff {
    dispatch: NotificationDispatch,
    dispatcher: NotificationDispatcher,
    session_permits: SessionPermits,
    queued_overflows: Arc<Mutex<HashSet<String>>>,
}

fn handoff() -> Handoff {
    let queued_overflows = Arc::new(Mutex::new(HashSet::new()));
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
    let session_permits = SessionPermits::default();
    let (queue, notifications) = mpsc::channel(NOTIFICATION_DISPATCH_CAPACITY);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(NOTIFICATION_HANDLER_CAPACITY)),
        session_permits: Arc::clone(&session_permits),
        queued_overflows: Arc::clone(&queued_overflows),
        saturated_overflow: Arc::clone(&saturated_overflow),
    };
    let (closed, _) = watch::channel(false);
    let ignore: NotificationHandler = Arc::new(|_| {});
    let dispatcher = NotificationDispatcher {
        queue: notifications,
        applied: watch::channel(0).0,
        handler: Arc::clone(&ignore),
        overflow: ignore,
        queued_overflows: Arc::clone(&queued_overflows),
        saturated_overflow,
        closed,
    };
    Handoff {
        dispatch,
        dispatcher,
        session_permits,
        queued_overflows,
    }
}

impl Handoff {
    fn send(&self, session_id: &str, count: usize) -> Result<(), String> {
        for sequence in 0..count {
            if !self
                .dispatch
                .try_send(session_notification("item/completed", session_id))
            {
                return Err(format!("{session_id} frame {sequence} was refused"));
            }
        }
        Ok(())
    }

    fn overflowed(&self, session_id: &str) -> bool {
        lock_notification_overflows(&self.queued_overflows).contains(session_id)
    }

    fn counted(&self) -> HashMap<String, usize> {
        lock_session_permits(&self.session_permits).clone()
    }

    fn held(&self) -> usize {
        NOTIFICATION_HANDLER_CAPACITY - self.dispatch.notification_capacity.available_permits()
    }
}

#[test]
fn a_session_at_its_share_fails_first_once_another_session_holds_a_permit() -> Result<(), String> {
    let handoff = handoff();
    handoff.send("quiet", 1)?;
    handoff.send("noisy", SHARE)?;
    if handoff.overflowed("noisy") {
        return Err("noisy overflowed below its share".to_owned());
    }

    handoff.send("noisy", 1)?;
    if !handoff.overflowed("noisy") {
        return Err("noisy took a permit past its share while quiet held one".to_owned());
    }
    if handoff.held() != SHARE + 1 {
        return Err(format!(
            "the refused frame took a permit: {} held",
            handoff.held()
        ));
    }
    if handoff.counted().get("noisy") != Some(&SHARE) {
        return Err(format!(
            "the refused frame was counted: {:?}",
            handoff.counted().get("noisy")
        ));
    }
    handoff.send("quiet", 1)?;
    if handoff.overflowed("quiet") {
        return Err("quiet overflowed while permits were free".to_owned());
    }
    if handoff.held() != SHARE + 2 {
        return Err(format!(
            "quiet's second frame took no permit: {} held",
            handoff.held()
        ));
    }
    Ok(())
}

#[test]
fn a_session_past_its_share_alone_fails_first_once_a_newcomer_holds_a_permit() -> Result<(), String>
{
    let handoff = handoff();
    handoff.send("noisy", SHARE + 44)?;
    handoff.send("quiet", 1)?;
    if handoff.overflowed("noisy") || handoff.overflowed("quiet") {
        return Err("a frame overflowed while permits were free".to_owned());
    }

    handoff.send("noisy", 1)?;
    if !handoff.overflowed("noisy") {
        return Err("noisy took another permit while quiet held one".to_owned());
    }
    if handoff.held() != SHARE + 45 {
        return Err(format!(
            "the refused frame took a permit: {} held",
            handoff.held()
        ));
    }
    Ok(())
}

#[test]
fn a_session_alone_keeps_the_whole_pool() -> Result<(), String> {
    let handoff = handoff();
    handoff.send("noisy", NOTIFICATION_HANDLER_CAPACITY)?;
    if handoff.overflowed("noisy") || handoff.held() != NOTIFICATION_HANDLER_CAPACITY {
        return Err(format!(
            "a session alone was refused before the pool filled: {} held",
            handoff.held()
        ));
    }
    // With every permit taken, a newcomer's first frame overflows as before.
    handoff.send("quiet", 1)?;
    if !handoff.overflowed("quiet") {
        return Err("quiet took a permit from a full pool".to_owned());
    }
    if handoff.counted().contains_key("quiet") {
        return Err("quiet's refused frame was counted".to_owned());
    }
    Ok(())
}

#[test]
fn frames_without_a_session_do_not_count_as_another_session() -> Result<(), String> {
    let handoff = handoff();
    handoff.send("noisy", SHARE)?;
    if !handoff
        .dispatch
        .try_send(notification_without_session("server/status"))
    {
        return Err("the sessionless frame was refused".to_owned());
    }
    handoff.send("noisy", 1)?;
    if handoff.overflowed("noisy") {
        return Err("a sessionless frame made noisy's pool contended".to_owned());
    }
    if handoff.held() != SHARE + 2 {
        return Err(format!("a frame took no permit: {} held", handoff.held()));
    }
    Ok(())
}

#[test]
fn a_session_back_below_its_share_takes_permits_again() -> Result<(), String> {
    let mut handoff = handoff();
    handoff.send("noisy", SHARE)?;
    handoff.send("quiet", 1)?;
    // The dispatcher starts noisy's oldest frame, releasing its permit.
    if !matches!(
        handoff.dispatcher.queue.try_recv(),
        Ok(NotificationDispatchItem::Notification { .. })
    ) {
        return Err("noisy's oldest frame was not queued first".to_owned());
    }
    handoff.send("noisy", 1)?;
    if handoff.overflowed("noisy") {
        return Err("noisy was refused below its share".to_owned());
    }
    let counted = handoff.counted();
    if counted.get("noisy") != Some(&SHARE) || counted.get("quiet") != Some(&1) {
        return Err(format!("unexpected per-session counts: {counted:?}"));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn applying_every_frame_releases_every_session_count() -> Result<(), String> {
    let handoff = handoff();
    handoff.send("noisy", SHARE + 1)?;
    handoff.send("quiet", 2)?;
    if !handoff
        .dispatch
        .try_send(notification_without_session("server/status"))
    {
        return Err("the sessionless frame was refused".to_owned());
    }
    let counted = handoff.counted();
    if counted.len() != 2 {
        return Err(format!("a sessionless frame was counted: {counted:?}"));
    }

    let Handoff {
        dispatch,
        dispatcher,
        session_permits,
        ..
    } = handoff;
    drop(dispatch);
    dispatcher.run().await;
    let counted = lock_session_permits(&session_permits);
    if !counted.is_empty() {
        return Err(format!("released permits left counts: {counted:?}"));
    }
    Ok(())
}

/// Through the driver: a routed `approval/request` from a session at its
/// share is refused like a notification, fails only that session, and still
/// gets its `{}` receipt.
#[tokio::test(flavor = "current_thread")]
async fn a_routed_approval_from_a_session_at_its_share_overflows_and_still_gets_a_receipt()
-> Result<(), String> {
    let (transport, mut peer) = test_transport();
    let (overflowed_session, mut overflowed) = mpsc::unbounded_channel();
    let (_connection, driver, dispatcher) = Connection::with_notification_handler(
        transport,
        |_| {},
        move |notification| {
            if let Some(session_id) = notification_session_id(&notification) {
                let _ = overflowed_session.send(session_id);
            }
        },
    );
    let frame = |session_id: &str| {
        json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":session_id}})
            .to_string()
    };
    let mut inbound = frame("quiet");
    inbound.push('\n');
    for _ in 0..SHARE {
        inbound.push_str(&frame("noisy"));
        inbound.push('\n');
    }
    inbound.push_str(
        &json!({"jsonrpc":"2.0","id":7,"method":"approval/request","params":{"sessionId":"noisy"}})
            .to_string(),
    );
    inbound.push('\n');
    peer.incoming
        .send(inbound)
        .map_err(|_| "share fixture could not reach the driver".to_owned())?;

    let mut driver = Box::pin(driver.run());
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver returned before its input ended".to_owned());
    }
    let reply = peer
        .outgoing
        .try_recv()
        .map_err(|error| format!("refused approval/request got no receipt: {error}"))?;
    if serde_json::from_str::<Value>(&reply).ok()
        != Some(json!({"jsonrpc":"2.0","id":7,"result":{}}))
    {
        return Err(format!(
            "refused approval/request got the wrong reply: {reply}"
        ));
    }

    drop(peer);
    let dispatcher_task = tokio::spawn(dispatcher.run());
    driver.await;
    dispatcher_task
        .await
        .map_err(|error| format!("notification dispatcher task did not join: {error}"))?;
    let mut sessions = Vec::new();
    while let Ok(session_id) = overflowed.try_recv() {
        sessions.push(session_id);
    }
    if sessions != ["noisy"] {
        return Err(format!(
            "only noisy should overflow, on its routed approval: {sessions:?}"
        ));
    }
    Ok(())
}

/// A count is released when the dispatcher starts applying its frame, not
/// when it takes the batch: while one handler call runs, frames behind it in
/// the same batch still count against their session.
#[tokio::test(flavor = "current_thread")]
async fn a_batched_frame_counts_against_its_session_until_its_handler_call_starts()
-> Result<(), String> {
    let (started_tx, mut started_rx) = mpsc::unbounded_channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = StdMutex::new(release_rx);
    let mut handoff = handoff();
    handoff.dispatcher.handler = Arc::new(move |notification: Notification| {
        if notification_session_id(&notification).as_deref() == Some("first") {
            let _ = started_tx.send(());
            let _ = release_rx
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .recv();
        }
    });
    handoff.send("first", 1)?;
    handoff.send("second", 2)?;

    let Handoff {
        dispatch,
        dispatcher,
        session_permits,
        ..
    } = handoff;
    drop(dispatch);
    let while_first_runs = async {
        let started = started_rx.recv().await;
        let counted = lock_session_permits(&session_permits).clone();
        let _ = release_tx.send(());
        (started, counted)
    };
    let ((started, counted), ()) = tokio::join!(while_first_runs, dispatcher.run());

    if started.is_none() {
        return Err("the first handler call never started".to_owned());
    }
    if counted != HashMap::from([("second".to_owned(), 2)]) {
        return Err(format!(
            "counts while the first call ran: {counted:?}; second's two frames must still count"
        ));
    }
    Ok(())
}
