// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session_config_mt::SessionModelEndpointTransportOverride;
use super::session_config_mt::SessionSettingsOverrides;
use super::session_mcp_server::SessionMcpNameKind;
pub use super::session_mcp_server::SessionMcpServerConfig;
use super::session_mcp_server::validate_name;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error as _;
use std::collections::BTreeMap;
use std::fmt;

/// The open configuration extension object shared by `session/start` and
/// `session/resume`.
///
/// Unknown keys are ignored on the wire, never rejected: the live decoder
/// tolerates them, and no exported bundle carries `additionalProperties:
/// false`. The Rust typed model's `deny_unknown_fields` is internal and never
/// exported — the closedness export applies nowhere, and the `x-msp-closed`
/// opt-in mechanism stays inert. Recognized `mcpServers` values are typed and
/// validated before they leave the wire boundary.
#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    /// Native MCP servers added only to this session runtime.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_servers: BTreeMap<String, SessionMcpServerConfig>,
    /// Experimental: a flat settings patch composing for this session's loads
    /// only. Secret-shaped keys fail the decode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_overrides: Option<SessionSettingsOverrides>,
    /// Experimental: the model endpoint transport this session's model
    /// consumers resolve against at load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_endpoint_transport_override: Option<SessionModelEndpointTransportOverride>,
    /// Experimental: this session's tool-output byte budget, as `muse exec
    /// --max-tool-output-bytes` sets it for a headless run. `0` means no limit;
    /// a positive value must be at least 9. The budget applies only on a host
    /// whose default-off `tool_output_budget` gate serves it: there, each
    /// model-visible tool result, from workspace and MCP tools alike, is
    /// bounded at this many bytes from the runtime's construction. Other hosts
    /// accept a valid value and ignore it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tool_output_bytes: Option<u64>,
    /// Experimental (owner decision: build tools and MCP first, design kt-2n1z):
    /// the per-session built-in tool restriction on `session/start` and
    /// `session/resume`: omitted = no restriction, `[]` = no built-in
    /// tools, a non-empty list = exactly those tools. Names are exact,
    /// case-sensitive built-in names; order is insignificant. This
    /// decoder checks the SHAPE only. Until the last enforcing piece
    /// lands, a host refuses any spelled member (P5, kt-kqr8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_built_in_tools: Option<Vec<String>>,
    /// Experimental: per-session admission of this session's
    /// `config.mcpServers` roster. Spelled `true` admits exactly that
    /// roster; spelled `false` is withheld, spelled. Omitted keeps
    /// today's withheld behaviour. Explicit `null` and any non-boolean
    /// fail the decode. Until the admission gate and its enforcing
    /// pieces land, the doors refuse every spelled value
    /// unconditionally, so no host can believe a roster was admitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub admit_session_mcp_servers: Option<bool>,
    /// Developer instructions for this session only, on `session/start` and
    /// `session/resume`. The text is trimmed. A nonblank value replaces the
    /// settings-derived developer instructions; an omitted member is no
    /// override and keeps the full developer context. Explicit `null` and blank
    /// text are the explicit clear (the Rust value is an empty string): no
    /// override, and on a host that serves developer instructions they also
    /// turn off the session's suppressible developer context (the agent catalog
    /// and the memory snapshot). Any other type fails the decode. A host that
    /// does not serve developer instructions ignores a valid member.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_prompt: Option<String>,
}

impl fmt::Debug for SessionConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionConfig")
            .field(
                "mcp_server_names",
                &self.mcp_servers.keys().collect::<Vec<_>>(),
            )
            .field("settings_overrides", &self.settings_overrides)
            .field(
                "model_endpoint_transport_override",
                &self.model_endpoint_transport_override,
            )
            .field("max_tool_output_bytes", &self.max_tool_output_bytes)
            .field("admit_session_mcp_servers", &self.admit_session_mcp_servers)
            .field(
                "allowed_built_in_tool_count",
                &self.allowed_built_in_tools.as_ref().map(Vec::len),
            )
            .field(
                "developer_prompt_bytes",
                &self.developer_prompt.as_ref().map(String::len),
            )
            .finish()
    }
}

impl<'de> Deserialize<'de> for SessionConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            #[serde(default)]
            mcp_servers: BTreeMap<String, SessionMcpServerConfig>,
            #[serde(default)]
            settings_overrides: Option<SessionSettingsOverrides>,
            #[serde(default)]
            model_endpoint_transport_override: Option<SessionModelEndpointTransportOverride>,
            #[serde(default)]
            max_tool_output_bytes: Option<u64>,
            #[serde(default)]
            allowed_built_in_tools: Option<Vec<String>>,
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| D::Error::custom("session config must be an object"))?;
        if object
            .get("mcpServers")
            .is_some_and(|servers| !servers.is_object())
        {
            return Err(D::Error::custom(
                "session config mcpServers must be an object",
            ));
        }
        if object
            .get("settingsOverrides")
            .is_some_and(|overrides| !overrides.is_object())
        {
            return Err(D::Error::custom(
                "session config settingsOverrides must be an object",
            ));
        }
        if object
            .get("modelEndpointTransportOverride")
            .is_some_and(|transport| !transport.is_object())
        {
            return Err(D::Error::custom(
                "session config modelEndpointTransportOverride must be an object",
            ));
        }
        if object
            .get("maxToolOutputBytes")
            .is_some_and(|bytes| !bytes.is_u64())
        {
            return Err(D::Error::custom(
                "session config maxToolOutputBytes must be a non-negative integer",
            ));
        }
        if object
            .get("allowedBuiltInTools")
            .is_some_and(|tools| !is_non_empty_string_array(tools))
        {
            return Err(D::Error::custom(
                "session config allowedBuiltInTools must be an array of non-empty strings",
            ));
        }
        let admit_session_mcp_servers = match object.get("admitSessionMcpServers") {
            None => None,
            Some(serde_json::Value::Bool(admit)) => Some(*admit),
            Some(_) => {
                return Err(D::Error::custom(
                    "session config admitSessionMcpServers must be a boolean",
                ));
            }
        };
        let developer_prompt = match object.get("developerPrompt") {
            None => None,
            Some(serde_json::Value::Null) => Some(String::new()),
            Some(serde_json::Value::String(text)) => Some(text.trim().to_owned()),
            Some(_) => {
                return Err(D::Error::custom(
                    "session config developerPrompt must be a string or null",
                ));
            }
        };
        let wire: Wire = serde_json::from_value(value).map_err(D::Error::custom)?;
        for name in wire.mcp_servers.keys() {
            validate_name(name, SessionMcpNameKind::Server).map_err(D::Error::custom)?;
        }
        Ok(Self {
            mcp_servers: wire.mcp_servers,
            settings_overrides: wire.settings_overrides,
            model_endpoint_transport_override: wire.model_endpoint_transport_override,
            max_tool_output_bytes: wire.max_tool_output_bytes,
            allowed_built_in_tools: wire.allowed_built_in_tools,
            admit_session_mcp_servers,
            developer_prompt,
        })
    }
}

/// The `allowedBuiltInTools` shape: an array whose every element is a
/// non-blank string. Anything else fails the decode.
fn is_non_empty_string_array(value: &serde_json::Value) -> bool {
    value.as_array().is_some_and(|tools| {
        tools
            .iter()
            .all(|tool| tool.as_str().is_some_and(|tool| !tool.trim().is_empty()))
    })
}
