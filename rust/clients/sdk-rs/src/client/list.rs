//! Listing stored sessions over `session/list`.

use crate::msp::{SessionListFilter, SessionListParams, SessionListResult};

use super::{FacadeResult, MuseClient};

/// Options for [`MuseClient::list_sessions`]. A field left `None` is not sent.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ListSessionsOptions {
    /// The page cursor a previous listing returned as `next_cursor`; `None`
    /// asks for the first page.
    pub cursor: Option<String>,
    /// The page size; the server applies its own default and maximum.
    pub limit: Option<u32>,
    /// Only sessions whose workspace root is this path.
    pub workspace_root: Option<String>,
    /// Only sessions with activity after this RFC 3339 instant.
    pub updated_after: Option<String>,
    /// Selects sessions by id, branch, or name and title text. A server that
    /// applies it echoes it as the result's `applied_filter`.
    pub filter: Option<SessionListFilter>,
}

impl MuseClient {
    /// Lists the host's stored sessions, newest activity first, one page per
    /// call. A read-only query: it opens and subscribes to nothing.
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
        self.shared.command("session/list", &params).await
    }
}
