use crate::connection::{Connection, ConnectionError, ProtocolError};
use crate::handshake::{HandshakeConnection, HandshakeFuture};

impl HandshakeConnection for Connection {
    type Error = ConnectionError;

    fn request<'a>(
        &'a mut self,
        method: &'static str,
        params: serde_json::Value,
    ) -> HandshakeFuture<'a, serde_json::Value, Self::Error> {
        Box::pin(async move {
            let params = params.as_object().cloned().ok_or_else(|| {
                ConnectionError::Protocol(ProtocolError::new(
                    "handshake request params must be an object",
                    None,
                ))
            })?;
            Connection::request(self, method, Some(params))
                .await
                .map(serde_json::Value::Object)
        })
    }

    fn notify<'a>(&'a mut self, method: &'static str) -> HandshakeFuture<'a, (), Self::Error> {
        Box::pin(Connection::notify(self, method, None))
    }
}
