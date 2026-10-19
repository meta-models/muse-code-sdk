use std::future::{Future, poll_fn};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::task::Poll;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;

mod batching;
mod close_settlement;
mod dispatch_capacity;
mod dispatch_order;
mod overflow;
mod overflow_cap;
mod session_share;
mod stdio;
mod transport_errors;

struct TestTransport {
    incoming: mpsc::UnboundedReceiver<String>,
    outgoing: mpsc::UnboundedSender<String>,
}

struct TestPeer {
    incoming: mpsc::UnboundedSender<String>,
    outgoing: mpsc::UnboundedReceiver<String>,
}

impl DuplexTransport for TestTransport {
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
        Box::pin(async move { Ok(self.incoming.recv().await) })
    }

    fn write(&mut self, frame: &str) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let result = self
            .outgoing
            .send(frame.to_owned())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "test peer closed"));
        Box::pin(async move { result })
    }
}

fn test_transport() -> (TestTransport, TestPeer) {
    let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
    let (outgoing_tx, outgoing_rx) = mpsc::unbounded_channel();
    (
        TestTransport {
            incoming: incoming_rx,
            outgoing: outgoing_tx,
        },
        TestPeer {
            incoming: incoming_tx,
            outgoing: outgoing_rx,
        },
    )
}

fn request_id(frame: &str) -> Option<Value> {
    serde_json::from_str::<Value>(frame)
        .ok()?
        .get("id")
        .cloned()
}

fn notification_session_id(notification: &crate::msp::Notification) -> Option<String> {
    notification
        .params
        .as_ref()?
        .get("sessionId")?
        .as_str()
        .map(str::to_owned)
}

async fn poll_once<F: Future + ?Sized>(mut future: Pin<&mut F>) -> Option<F::Output> {
    poll_fn(|context| {
        Poll::Ready(match future.as_mut().poll(context) {
            Poll::Ready(output) => Some(output),
            Poll::Pending => None,
        })
    })
    .await
}

fn session_notification(method: &str, session_id: &str) -> Notification {
    let mut params = serde_json::Map::new();
    params.insert(
        "sessionId".to_owned(),
        serde_json::Value::String(session_id.to_owned()),
    );
    Notification {
        jsonrpc: JsonRpcVersion::V2,
        method: method.to_owned(),
        params: Some(params),
        emitted_at_ms: None,
    }
}

#[test]
fn notification_session_lookup_borrows_from_the_frame() -> Result<(), String> {
    let notification = session_notification("item/completed", "session-1");
    let session_id: Option<&str> = super::notification_session_id(&notification);
    if session_id != Some("session-1") {
        return Err(format!(
            "unexpected notification session id: {session_id:?}"
        ));
    }
    Ok(())
}

fn notification_without_session(method: &str) -> Notification {
    Notification {
        jsonrpc: JsonRpcVersion::V2,
        method: method.to_owned(),
        params: None,
        emitted_at_ms: None,
    }
}
