// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session_config_mt::SessionEndpointTransportAuthMode;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::de::Error as _;
use std::collections::BTreeMap;
use std::fmt;

/// The header-name rule every header map of the override follows.
pub(super) fn check_header_names<'a>(
    names: impl IntoIterator<Item = &'a String>,
) -> Result<(), &'static str> {
    for name in names {
        if name.trim().is_empty() {
            return Err(
                "session config modelEndpointTransportOverride header name must not be blank",
            );
        }
        if name.trim() != name {
            return Err(
                "session config modelEndpointTransportOverride header name must not contain surrounding whitespace",
            );
        }
    }
    Ok(())
}

/// AC-D5: `providers` of the transport override. Closed: a provider this
/// version does not name fails the decode.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionEndpointProviders {
    /// Merged field by field over the top-level fields for the session's
    /// Meta endpoint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<SessionEndpointProviderOverride>,
    /// The session's own Anthropic endpoint, which serves its Claude
    /// models; it inherits nothing from the top level and needs a
    /// `baseUrl`. Absent: the host's Anthropic route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic: Option<SessionEndpointProviderOverride>,
}

impl fmt::Debug for SessionEndpointProviders {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEndpointProviders")
            .field("meta", &self.meta)
            .field("anthropic", &self.anthropic)
            .finish()
    }
}

/// One provider's endpoint: the top level's transport fields, under the
/// same wire names, without `allowOpenai`. Closed: an unknown field fails
/// the decode.
#[derive(Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEndpointProviderOverride {
    /// Endpoint base URL. Configuration diagnostics never echo it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
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
    /// Auth mode. Absent = `bearer`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<SessionEndpointTransportAuthMode>,
}

impl fmt::Debug for SessionEndpointProviderOverride {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionEndpointProviderOverride")
            .field("base_url_present", &self.base_url.is_some())
            .field("http_header_name_count", &self.http_headers.len())
            .field("env_http_header_name_count", &self.env_http_headers.len())
            .field("proxy_present", &self.proxy.is_some())
            .field("client_cert_present", &self.client_cert.is_some())
            .field("client_key_present", &self.client_key.is_some())
            .field("ca_bundle_present", &self.ca_bundle.is_some())
            .field("auth", &self.auth)
            .finish()
    }
}

impl<'de> Deserialize<'de> for SessionEndpointProviderOverride {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Wire {
            #[serde(default)]
            base_url: Option<String>,
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
        }

        let wire = Wire::deserialize(deserializer).map_err(|_| {
            D::Error::custom(
                "session config modelEndpointTransportOverride.providers has a provider that is not an object, a field with the wrong type, or an unknown field",
            )
        })?;
        check_header_names(wire.http_headers.keys().chain(wire.env_http_headers.keys()))
            .map_err(D::Error::custom)?;
        Ok(Self {
            base_url: wire.base_url,
            http_headers: wire.http_headers,
            env_http_headers: wire.env_http_headers,
            proxy: wire.proxy,
            client_cert: wire.client_cert,
            client_key: wire.client_key,
            ca_bundle: wire.ca_bundle,
            auth: wire.auth,
        })
    }
}
