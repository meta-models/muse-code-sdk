//! Listing stored sessions over `session/list`, including text search.

use crate::msp::{SessionListFilter, SessionListParams, SessionListResult};

use super::{FacadeResult, MuseClient};

/// Options for [`MuseClient::list_sessions`]. A field left `None` is
/// omitted from the request.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListSessionsOptions {
    /// Opaque page cursor from a prior result.
    pub cursor: Option<String>,
    /// Page size; the server defaults and caps it when `None`.
    pub limit: Option<u32>,
    /// Only sessions whose metadata workspace root equals this path.
    pub workspace_root: Option<String>,
    /// Only sessions with log activity after this RFC3339 instant.
    pub updated_after: Option<String>,
    /// Structured selection, including text search via its `text` member.
    pub filter: Option<SessionListFilter>,
}

impl MuseClient {
    /// Lists stored sessions (`session/list`), including text search via
    /// `options.filter`'s text member.
    pub async fn list_sessions(
        &self,
        options: ListSessionsOptions,
    ) -> FacadeResult<SessionListResult> {
        let params = SessionListParams {
            cursor: options.cursor,
            limit: options.limit,
            workspace_root: options.workspace_root,
            updated_after: options.updated_after,
            filter: options.filter,
        };
        self.shared
            .command::<_, SessionListResult>("session/list", &params)
            .await
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    use tokio::sync::mpsc;

    use super::*;
    use crate::DuplexTransport;
    use crate::client::MuseClient;
    use crate::msp::{
        SessionDurability, SessionListFilter, SessionListTextField, SessionListTextFilter,
    };

    struct ScriptedTransport {
        inbound: mpsc::UnboundedReceiver<String>,
        outbound: mpsc::UnboundedSender<String>,
        writes: Arc<Mutex<Vec<String>>>,
    }

    impl DuplexTransport for ScriptedTransport {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            Box::pin(async { Ok(self.inbound.recv().await) })
        }

        fn write(
            &mut self,
            frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            if let Ok(mut writes) = self.writes.lock() {
                writes.push(frame.to_owned());
            }
            if let Ok(request) = serde_json::from_str::<serde_json::Value>(frame.trim())
                && request["method"] == "session/list"
            {
                let reply = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": request["id"].clone(),
                    "result": {"sessions": [], "nextCursor": null}
                });
                let _ = self.outbound.send(format!("{reply}\n"));
            }
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_sessions_sends_session_list_with_text_filter() {
        let (outbound, inbound) = mpsc::unbounded_channel();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let client = MuseClient::with_command_id_minter(
            ScriptedTransport {
                inbound,
                outbound,
                writes: Arc::clone(&writes),
            },
            SessionDurability::Durable,
            || "command-1".to_owned(),
        );
        let result = client
            .list_sessions(ListSessionsOptions {
                filter: Some(SessionListFilter {
                    text: Some(SessionListTextFilter {
                        fields: vec![SessionListTextField::Title],
                        all_of: Some(vec!["check".to_owned()]),
                        any_of: None,
                    }),
                    ..SessionListFilter::default()
                }),
                ..ListSessionsOptions::default()
            })
            .await
            .expect("list_sessions");
        assert!(result.sessions.is_empty());
        assert_eq!(result.next_cursor, None);
        {
            let guard = writes.lock().expect("writes lock");
            assert_eq!(guard.len(), 1);
            let frame: serde_json::Value =
                serde_json::from_str(guard[0].trim()).expect("frame is json");
            assert_eq!(frame["method"], "session/list");
            assert_eq!(
                frame["params"]["filter"]["text"],
                serde_json::json!({"allOf": ["check"], "fields": ["title"]})
            );
        }
        client.close().await;
    }
}
