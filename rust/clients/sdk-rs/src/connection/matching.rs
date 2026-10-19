use std::fmt;

use crate::msp::RequestId;

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
pub(super) enum RequestKey {
    Integer(i64),
    String(String),
}

impl From<&RequestId> for RequestKey {
    fn from(id: &RequestId) -> Self {
        match id {
            RequestId::Integer(value) => Self::Integer(*value),
            RequestId::String(value) => Self::String(value.clone()),
        }
    }
}

pub(super) struct DisplayRequestId<'a>(pub(super) &'a RequestId);

impl fmt::Display for DisplayRequestId<'_> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0 {
            RequestId::Integer(value) => value.fmt(formatter),
            RequestId::String(value) => value.fmt(formatter),
        }
    }
}
