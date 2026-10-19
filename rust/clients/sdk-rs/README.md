# `muse-code-sdk`

The Rust SDK for Muse Code: an async client for driving a Muse Code agent
over the Muse Session Protocol (MSP), on your own Tokio runtime.

- Spawn a `muse serve` host, or attach to a transport you already run.
- Open and resume sessions; stream a turn's items as they arrive and await
  the turn's server-authored outcome.
- Answer tool-approval requests with a handler you register.
- A client-side fold keeps a live, typed view of the session, with gap
  recovery after reconnects and safe same-command retry that never
  double-submits.

The generated MSP wire types are in `muse_code_sdk::msp`. Rust 1.97+.

## Versioning and stability

- The crate version is the Muse Code release it ships with: `muse-code-sdk`
  `X.Y.Z` pairs with Muse Code `X.Y.Z`, and every release moves both together.
- The stable MSP surface follows the Muse Code product's compatibility
  promise. Surfaces marked experimental may change or be removed in any
  release.
- Cargo treats every `1.x` release as compatible, but a Muse Code minor
  release can change the protocol. Pin the exact version that matches your
  Muse Code release:

  ```toml
  [dependencies]
  muse-code-sdk = "=X.Y.Z"
  ```

- Open protocol enums are `#[non_exhaustive]`: a `match` on them needs a
  catch-all `_` arm, and a release that adds a value does not break your
  build.
- So are the SDK's own public enums (its errors, outcomes and states): match
  them with a catch-all `_` arm too, and a release that adds an error or an
  outcome does not break your build.
- Protocol structs that you only receive from the host (results,
  notifications, items, error objects) are `#[non_exhaustive]` too, so a
  release that adds a field does not break your build; to build one, for
  example in a test that scripts a host, decode it from its wire JSON. The
  params you send (`TurnInputPart`, `SessionConfig`, and the params of every
  method) stay buildable with struct literals.

## Before you start

- **Install Muse Code.** `curl https://dev.meta.ai/install.sh | bash` installs
  a checksum-verified `muse` launcher in `~/.local/bin`, adds it to your
  `PATH`, and keeps it up to date; the
  [user manual](https://dev.meta.ai/docs/muse-code) has the details. Open a
  new shell afterwards. The SDK runs the binary you name in
  `SpawnOptions::muse_bin`, or else the first `muse` on `PATH`: a program
  started from a shell opened before the install fails with "no muse host
  found", and an older `muse` earlier on `PATH` is used silently.
- **Log in once.** Run `muse` and log in, so the host has provider
  credentials. A host without them fails every turn.
- **Pair the versions.** Run `muse --version` and install this crate at that
  same `X.Y.Z` (see Versioning and stability above). The installed `muse`
  updates itself, so it can move ahead of your pinned crate. If that release
  changed the protocol, the connection reports `fingerprint_warning` and stays
  open, but calls whose shape changed can fail. Either way, move your pin to
  the version `muse --version` prints.

## Install

```sh
cargo add muse-code-sdk@=X.Y.Z
cargo add tokio --features macros,rt
```

The second line is for the sample below: it runs on tokio
(`#[tokio::main]`), which this crate uses but does not re-export.

## Use

```rust,no_run
use muse_code_sdk::client::{MuseClient, StartSessionOptions};
use muse_code_sdk::msp::{TurnInputPart, TurnInputPartType};
use muse_code_sdk::session::SendUserTurnOptions;
use muse_code_sdk::spawn::SpawnOptions;
use muse_code_sdk::turn::TurnOutcome;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let connection = MuseClient::spawn(SpawnOptions::default()).await?;
    let client = connection.client;
    let session = client.start_session(StartSessionOptions::default()).await?;
    let turn = session
        .send_user_turn(SendUserTurnOptions {
            input: vec![text_part("Summarize this repository.")],
            ..SendUserTurnOptions::default()
        })
        .await?;

    let mut items = turn.items();
    while let Some(item) = items.recv().await? {
        println!("{:?}", item.kind);
    }
    match turn.completed().await? {
        TurnOutcome::Completed { params, .. } => println!("turn ended as {:?}", params.terminal),
        TurnOutcome::Unqueued(params) => println!("turn {} was unqueued", params.turn_id),
        _ => println!("turn ended"),
    }
    client.close().await;
    Ok(())
}

fn text_part(text: impl Into<String>) -> TurnInputPart {
    TurnInputPart {
        part_type: TurnInputPartType::Text,
        text: Some(text.into()),
        media_type: None,
        base64_data: None,
        width: None,
        height: None,
        selector: None,
        arguments: None,
        upload_id: None,
        source: None,
    }
}
```

The crate's `examples/` directory has a fuller quickstart and recipes for
approvals, retries, and cancellation.

## Documentation

- API reference: <https://docs.rs/muse-code-sdk>
- Guides and the protocol reference: <https://meta-models.github.io/muse-code-sdk/>
- Source and issues: <https://github.com/meta-models/muse-code-sdk>

## License

MIT. See `LICENSE`.
