//! User-input answers through a session.

use crate::client::FacadeResult;
use crate::errors::ProtocolError;
use crate::msp::{UserInputAnswer, UserInputAnswerParams, UserInputAnswerResult};

use super::Session;

impl Session {
    /// Answers a pending user-input question with `userInput/answer`.
    ///
    /// The result is the server's admission only; the question settles when
    /// the server's `userInput/settled` event arrives. Pass `user_input_id`
    /// exactly as the server sent it (the `userInputId` of a
    /// `pending_user_inputs()` entry of [`Session::fold`]): the echoed id is
    /// compared byte for byte.
    pub async fn answer_user_input(
        &self,
        user_input_id: impl Into<String>,
        answers: Vec<UserInputAnswer>,
    ) -> FacadeResult<UserInputAnswerResult> {
        self.inner.ensure_available()?;
        let command_id = self.inner.client.mint_command_id()?;
        let params = UserInputAnswerParams {
            session_id: self.inner.session_id.clone(),
            command_id,
            user_input_id: user_input_id.into(),
            answers,
        };
        let result = self
            .inner
            .client
            .command::<_, UserInputAnswerResult>("userInput/answer", &params)
            .await?;
        if result.command_id != params.command_id || result.user_input_id != params.user_input_id {
            return Err(ProtocolError::new(
                format!(
                    "userInput/answer echoed command {} for question {}, expected command {} for question {}",
                    result.command_id, result.user_input_id, params.command_id, params.user_input_id
                ),
                None,
            )
            .into());
        }
        super::submit::require_accepted("userInput/answer", &result.status)?;
        Ok(result)
    }
}
