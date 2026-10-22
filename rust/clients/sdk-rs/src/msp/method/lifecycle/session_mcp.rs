// @generated from the MSP stable schema and protocol sources; do not edit by hand.

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
}

impl fmt::Debug for SessionConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionConfig")
            .field(
                "mcp_server_names",
                &self.mcp_servers.keys().collect::<Vec<_>>(),
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
        let wire: Wire = serde_json::from_value(value).map_err(D::Error::custom)?;
        for name in wire.mcp_servers.keys() {
            validate_name(name, SessionMcpNameKind::Server).map_err(D::Error::custom)?;
        }
        Ok(Self {
            mcp_servers: wire.mcp_servers,
        })
    }
}

/// One native MCP server supplied at session construction.
///
/// **Closed union**: a validator MUST reject an undeclared `transport` arm —
/// the server fails `session/start` decode on an unknown transport, and a
/// future transport arrives as an explicit schema addition.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
pub enum SessionMcpServerConfig {
    /// A child process speaking MCP over stdin/stdout.
    Stdio {
        /// Executable name or path. Configuration diagnostics never echo it.
        command: String,
        /// Ordered child arguments.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        args: Vec<String>,
        /// Explicit child environment additions.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        env: BTreeMap<String, String>,
        /// Stdio framing mode; defaults to automatic detection.
        #[serde(default, skip_serializing_if = "SessionMcpStdioFraming::is_auto")]
        framing: SessionMcpStdioFraming,
        /// Required/optional startup posture; defaults to required.
        #[serde(default, skip_serializing_if = "SessionMcpServerMode::is_required")]
        mode: SessionMcpServerMode,
    },
    /// A streamable-HTTP MCP endpoint.
    StreamableHttp {
        /// HTTP(S) endpoint. Configuration diagnostics never echo it.
        url: String,
        /// Explicit request headers.
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        headers: BTreeMap<String, String>,
        /// Required/optional startup posture; defaults to required.
        #[serde(default, skip_serializing_if = "SessionMcpServerMode::is_required")]
        mode: SessionMcpServerMode,
    },
}

impl fmt::Debug for SessionMcpServerConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Stdio {
                args,
                env,
                framing,
                mode,
                ..
            } => formatter
                .debug_struct("SessionMcpServerConfig::Stdio")
                .field("argument_count", &args.len())
                .field("environment_name_count", &env.len())
                .field("framing", framing)
                .field("mode", mode)
                .finish(),
            Self::StreamableHttp { headers, mode, .. } => formatter
                .debug_struct("SessionMcpServerConfig::StreamableHttp")
                .field("header_name_count", &headers.len())
                .field("mode", mode)
                .finish(),
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
enum SessionMcpServerConfigWire {
    Stdio {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        env: BTreeMap<String, String>,
        #[serde(default)]
        framing: SessionMcpStdioFraming,
        #[serde(default)]
        mode: SessionMcpServerMode,
    },
    StreamableHttp {
        url: String,
        #[serde(default)]
        headers: BTreeMap<String, String>,
        #[serde(default)]
        mode: SessionMcpServerMode,
    },
}

impl<'de> Deserialize<'de> for SessionMcpServerConfig {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value
            .as_object()
            .ok_or_else(|| D::Error::custom("MCP server definition must be an object"))?;
        let transport = object
            .get("transport")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| D::Error::custom("MCP server transport must be a string"))?;
        let (forbidden, required, missing_message): (&[&str], &str, &str) = match transport {
            "stdio" => (
                &["url", "headers"],
                "command",
                "MCP transport `stdio` requires field `command`",
            ),
            "streamableHttp" => (
                &["command", "args", "env", "framing"],
                "url",
                "MCP transport `streamableHttp` requires field `url`",
            ),
            _ => {
                return Err(D::Error::custom(
                    "MCP server transport must be `stdio` or `streamableHttp`",
                ));
            }
        };
        if !object.contains_key(required) {
            return Err(D::Error::custom(missing_message));
        }
        if let Some(field) = forbidden.iter().find(|field| object.contains_key(**field)) {
            return Err(D::Error::custom(format!(
                "field `{field}` is not valid for MCP transport `{transport}`"
            )));
        }
        let wire: SessionMcpServerConfigWire = serde_json::from_value(value).map_err(|_| {
            D::Error::custom(
                "MCP server definition has a field with the wrong type or an unknown option",
            )
        })?;
        let config = match wire {
            SessionMcpServerConfigWire::Stdio {
                command,
                args,
                env,
                framing,
                mode,
            } => Self::Stdio {
                command,
                args,
                env,
                framing,
                mode,
            },
            SessionMcpServerConfigWire::StreamableHttp { url, headers, mode } => {
                Self::StreamableHttp { url, headers, mode }
            }
        };
        config.validate().map_err(D::Error::custom)?;
        Ok(config)
    }
}

impl SessionMcpServerConfig {
    fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Stdio { command, env, .. } => {
                if command.trim().is_empty() {
                    return Err("stdio MCP command must not be blank");
                }
                validate_map_keys(env, SessionMcpNameKind::Environment)
            }
            Self::StreamableHttp { url, headers, .. } => {
                validate_streamable_http_url(url)?;
                validate_map_keys(headers, SessionMcpNameKind::Header)
            }
        }
    }
}

fn validate_streamable_http_url(url: &str) -> Result<(), &'static str> {
    let (scheme, remainder) = url
        .split_once("://")
        .ok_or("streamable HTTP MCP URL is invalid")?;
    if !(scheme.eq_ignore_ascii_case("http") || scheme.eq_ignore_ascii_case("https")) {
        return Err("streamable HTTP MCP URL must be an absolute HTTP(S) URL");
    }
    if url
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
    {
        return Err("streamable HTTP MCP URL is invalid");
    }

    let authority = remainder.split(['/', '?', '#']).next().unwrap_or_default();
    let host_and_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host_and_port)| host_and_port);
    let valid_authority = if let Some(bracketed) = host_and_port.strip_prefix('[') {
        bracketed
            .split_once(']')
            .is_some_and(|(host, suffix)| !host.is_empty() && valid_optional_port(suffix))
    } else {
        host_and_port.rsplit_once(':').map_or_else(
            || !host_and_port.is_empty(),
            |(host, port)| !host.is_empty() && !host.contains(':') && valid_port(port),
        )
    };
    if !valid_authority {
        return Err("streamable HTTP MCP URL must be an absolute HTTP(S) URL");
    }
    Ok(())
}

fn valid_optional_port(suffix: &str) -> bool {
    suffix.is_empty() || suffix.strip_prefix(':').is_some_and(valid_port)
}

fn valid_port(port: &str) -> bool {
    !port.is_empty()
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok()
}

#[derive(Clone, Copy)]
enum SessionMcpNameKind {
    Server,
    Environment,
    Header,
}

fn validate_map_keys(
    values: &BTreeMap<String, String>,
    kind: SessionMcpNameKind,
) -> Result<(), &'static str> {
    for name in values.keys() {
        validate_name(name, kind)?;
    }
    Ok(())
}

fn validate_name(name: &str, kind: SessionMcpNameKind) -> Result<(), &'static str> {
    if name.trim().is_empty() {
        return Err(match kind {
            SessionMcpNameKind::Server => "MCP server name must not be blank",
            SessionMcpNameKind::Environment => "MCP environment name must not be blank",
            SessionMcpNameKind::Header => "MCP header name must not be blank",
        });
    }
    if name.trim() != name {
        return Err(match kind {
            SessionMcpNameKind::Server => "MCP server name must not contain surrounding whitespace",
            SessionMcpNameKind::Environment => {
                "MCP environment name must not contain surrounding whitespace"
            }
            SessionMcpNameKind::Header => "MCP header name must not contain surrounding whitespace",
        });
    }
    Ok(())
}

/// Stdio framing choices exposed by session MCP configuration.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionMcpStdioFraming {
    /// Probe line-delimited JSON, then fall back to Content-Length framing.
    #[default]
    Auto,
    /// Require LSP-style Content-Length framing.
    ContentLength,
    /// Require one JSON object per line.
    LineDelimitedJson,
}

impl SessionMcpStdioFraming {
    fn is_auto(value: &Self) -> bool {
        *value == Self::Auto
    }
}

/// Startup failure posture for a session MCP server.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionMcpServerMode {
    /// Failure prevents provider contact.
    #[default]
    Required,
    /// Failure is reported through the existing diagnostic path and startup continues.
    Optional,
}

impl SessionMcpServerMode {
    fn is_required(value: &Self) -> bool {
        *value == Self::Required
    }
}
