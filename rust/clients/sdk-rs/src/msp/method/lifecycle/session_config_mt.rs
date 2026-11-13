// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error as _;
use std::collections::BTreeMap;
use std::fmt;

/// the governing rules: a flat settings patch for one session — dotted key
/// paths in file spelling verbatim (the `settings/*` key-path vocabulary)
/// mapped to their new absolute scalar values. `null` clears the member to
/// absent, exactly as a `settings/writeValue` edit does.
///
/// Credentials never travel here: a secret-shaped key (by key class, with
/// a fail-closed default for unrecognized secret-shaped spellings) fails
/// the decode at the wire boundary, before the value can reach any
/// settings composition.
#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct SessionSettingsOverrides {
    /// The patch entries, keyed by dotted key path verbatim. Private so
    /// every construction runs the key-class guard: the wire decoder and
    /// [`Self::new`] are the only doors, and neither admits a
    /// secret-shaped key.
    values: BTreeMap<String, SessionSettingsOverrideValue>,
}

impl SessionSettingsOverrides {
    /// The validated constructor: every key must pass the same
    /// fail-closed guard the wire decoder runs, so no caller can build
    /// (or mutate into) a patch carrying credential material.
    pub fn new(
        values: BTreeMap<String, SessionSettingsOverrideValue>,
    ) -> Result<Self, &'static str> {
        for key in values.keys() {
            validate_override_key(key)?;
        }
        Ok(Self { values })
    }

    /// One entry by dotted key path, if present.
    pub fn get(&self, key: &str) -> Option<&SessionSettingsOverrideValue> {
        self.values.get(key)
    }

    /// The patch entries, read-only.
    pub fn values(&self) -> &BTreeMap<String, SessionSettingsOverrideValue> {
        &self.values
    }
}

impl fmt::Debug for SessionSettingsOverrides {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionSettingsOverrides")
            .field("key_paths", &self.values.keys().collect::<Vec<_>>())
            .finish()
    }
}

impl<'de> Deserialize<'de> for SessionSettingsOverrides {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        let object = value.as_object().ok_or_else(|| {
            D::Error::custom("session config settingsOverrides must be an object")
        })?;
        let mut values = BTreeMap::new();
        for (key, value) in object {
            validate_override_key(key).map_err(D::Error::custom)?;
            let value = match value {
                serde_json::Value::String(text) => {
                    SessionSettingsOverrideValue::String(text.clone())
                }
                serde_json::Value::Bool(flag) => SessionSettingsOverrideValue::Bool(*flag),
                serde_json::Value::Null => SessionSettingsOverrideValue::Null,
                _ => {
                    return Err(D::Error::custom(
                        "session config settingsOverrides values must be strings, booleans, or null",
                    ));
                }
            };
            values.insert(key.clone(), value);
        }
        Ok(Self { values })
    }
}

/// One `SessionSettingsOverrides` leaf: exactly the `settings/*` write
/// value domain — a string, a boolean, or `null` for clear-to-absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SessionSettingsOverrideValue {
    /// A string leaf.
    String(String),
    /// A boolean leaf.
    Bool(bool),
    /// Clear the member to absent; the built-in fallback applies.
    Null,
}

fn validate_override_key(key: &str) -> Result<(), &'static str> {
    if key.trim().is_empty() {
        return Err("session config settingsOverrides keys must not be blank");
    }
    if key.trim() != key {
        return Err(
            "session config settingsOverrides keys must not contain surrounding whitespace",
        );
    }
    if key.split('.').any(str::is_empty) {
        return Err("session config settingsOverrides keys must not contain empty segments");
    }
    if is_secret_shaped_key(key) {
        return Err("session config settingsOverrides contains a secret-shaped key");
    }
    Ok(())
}

/// the governing rules key-class guard, fail-closed by meaning rather than by
/// one enumerated spelling list: the key is tokenized across `.`/`_`/`-`
/// separators and camelCase boundaries, then refused when any token, any fused
/// token containing a secret stem, or any adjacent token pair names credential
/// material — so `providerApiKey`, `model.access_token`, `x-client-secret`,
/// `signingPassphrase`, and `bearerTokenValue` all refuse alongside the bare
/// `api_key` spelling. Bare `*Key` spellings (`signingKey`, `encryptionKey`,
/// `masterKey`, `sshKey`) and the `pwd`, `jwt`, and `oauth` tokens refuse by
/// the same class: no legitimate settings key ends in a `key` token or names
/// any of them.
fn is_secret_shaped_key(key: &str) -> bool {
    const SECRET_TOKENS: &[&str] = &[
        "secret",
        "secrets",
        "token",
        "tokens",
        "password",
        "passphrase",
        "passwd",
        "pwd",
        "credential",
        "credentials",
        "bearer",
        "authorization",
        "auth",
        "apikey",
        "privatekey",
        "accesskey",
        "cookie",
        "cookies",
        "key",
        "jwt",
        "oauth",
    ];
    const SECRET_STEMS: &[&str] = &[
        "secret",
        "password",
        "passphrase",
        "passwd",
        "credential",
        "token",
        "apikey",
    ];
    let tokens = key_tokens(key);
    if tokens
        .iter()
        .any(|token| SECRET_TOKENS.contains(&token.as_str()))
    {
        return true;
    }
    if tokens.iter().any(|token| {
        SECRET_STEMS
            .iter()
            .any(|stem| token.len() > stem.len() && token.contains(stem))
    }) {
        return true;
    }
    if tokens
        .iter()
        .any(|token| token.len() > 3 && token.ends_with("key"))
    {
        return true;
    }
    tokens.windows(2).any(|pair| {
        matches!(
            (pair[0].as_str(), pair[1].as_str()),
            ("api", "key")
                | ("private", "key")
                | ("access", "key")
                | ("client", "secret")
                | ("shared", "secret")
        )
    })
}

/// Split a dotted key path into lowercase word tokens, breaking on every
/// non-alphanumeric separator and on camelCase boundaries (including the
/// acronym boundary in `APIKey` -> `api`, `key`).
fn key_tokens(key: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    for chunk in key.split(|c: char| !c.is_ascii_alphanumeric()) {
        if chunk.is_empty() {
            continue;
        }
        let chars: Vec<char> = chunk.chars().collect();
        let mut start = 0;
        for index in 1..chars.len() {
            let boundary = (chars[index - 1].is_ascii_lowercase()
                || chars[index - 1].is_ascii_digit())
                && chars[index].is_ascii_uppercase()
                || chars[index - 1].is_ascii_uppercase()
                    && chars[index].is_ascii_uppercase()
                    && chars.get(index + 1).is_some_and(|c| c.is_ascii_lowercase());
            if boundary {
                tokens.push(
                    chars[start..index]
                        .iter()
                        .collect::<String>()
                        .to_lowercase(),
                );
                start = index;
            }
        }
        tokens.push(chars[start..].iter().collect::<String>().to_lowercase());
    }
    tokens
}

/// the governing rules: the per-session model endpoint transport override,
/// mirroring the` `EndpointTransportConfig` fields under MSP camelCase wire
/// names (`base_url` -> `baseUrl`, `http_headers` -> `httpHeaders`, and so on;
/// the mTLS path fields travel as strings, paths being a host concern). Every
/// field is optional; all absent is the default transport. Resolution against
/// managed egress policy is a later slice.
#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelEndpointTransportOverride {
    /// Endpoint base URL. Configuration diagnostics never echo it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Closed grant allowing an explicit OpenAI URL to reuse this block.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow_openai: Option<bool>,
    /// Literal provider request headers.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub http_headers: BTreeMap<String, String>,
    /// Provider header name -> environment variable name.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env_http_headers: BTreeMap<String, String>,
    /// An explicit HTTP proxy URL. Diagnostics never echo it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    /// Path to the mTLS client certificate (PEM).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_cert: Option<String>,
    /// Path to the mTLS client private key (PEM).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_key: Option<String>,
    /// Optional CA bundle (PEM) to trust for the server side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ca_bundle: Option<String>,
    /// Auth mode. Absent = `bearer` (the default transport behavior).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<SessionEndpointTransportAuthMode>,
    /// Provider-scoped endpoints. `meta` merges over the fields above;
    /// `anthropic` is the session's own Anthropic endpoint. Absent: the fields
    /// above, and the host's Anthropic route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub providers: Option<super::SessionEndpointProviders>,
}

impl fmt::Debug for SessionModelEndpointTransportOverride {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionModelEndpointTransportOverride")
            .field("base_url_present", &self.base_url.is_some())
            .field("allow_openai", &self.allow_openai)
            .field("http_header_name_count", &self.http_headers.len())
            .field("env_http_header_name_count", &self.env_http_headers.len())
            .field("proxy_present", &self.proxy.is_some())
            .field("client_cert_present", &self.client_cert.is_some())
            .field("client_key_present", &self.client_key.is_some())
            .field("ca_bundle_present", &self.ca_bundle.is_some())
            .field("auth", &self.auth)
            .field("providers", &self.providers)
            .finish()
    }
}

impl<'de> Deserialize<'de> for SessionModelEndpointTransportOverride {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            #[serde(default)]
            base_url: Option<String>,
            #[serde(default)]
            allow_openai: Option<bool>,
            #[serde(default)]
            http_headers: BTreeMap<String, String>,
            #[serde(default)]
            env_http_headers: BTreeMap<String, String>,
            #[serde(default)]
            proxy: Option<String>,
            #[serde(default)]
            client_cert: Option<String>,
            #[serde(default)]
            client_key: Option<String>,
            #[serde(default)]
            ca_bundle: Option<String>,
            #[serde(default)]
            auth: Option<SessionEndpointTransportAuthMode>,
            #[serde(default)]
            providers: Option<super::SessionEndpointProviders>,
        }

        let value = serde_json::Value::deserialize(deserializer)?;
        if !value.is_object() {
            return Err(D::Error::custom(
                "session config modelEndpointTransportOverride must be an object",
            ));
        }
        let wire: Wire = serde_json::from_value(value).map_err(|_| {
            D::Error::custom(
                "session config modelEndpointTransportOverride has a field with the wrong type or an unknown option",
            )
        })?;
        super::session_config_mt_providers::check_header_names(
            wire.http_headers.keys().chain(wire.env_http_headers.keys()),
        )
        .map_err(D::Error::custom)?;
        Ok(Self {
            base_url: wire.base_url,
            allow_openai: wire.allow_openai,
            http_headers: wire.http_headers,
            env_http_headers: wire.env_http_headers,
            proxy: wire.proxy,
            client_cert: wire.client_cert,
            client_key: wire.client_key,
            ca_bundle: wire.ca_bundle,
            auth: wire.auth,
            providers: wire.providers,
        })
    }
}

/// How a request to the overridden endpoint authenticates, mirroring the`
/// `TransportAuthMode` spellings. Closed: an undeclared mode fails the decode
/// rather than degrading to a default.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionEndpointTransportAuthMode {
    /// Send the api key as a Bearer credential (the default).
    #[default]
    Bearer,
    /// Send no `Authorization` header; the transport carries identity.
    None,
}
