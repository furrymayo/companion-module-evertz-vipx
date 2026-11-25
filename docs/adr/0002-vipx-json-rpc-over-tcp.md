# 0002. Talk to the VIP-X over its JSON-RPC 2.0 TCP control API, with a version handshake

- **Status:** accepted
- **Date:** 2025-09-22
- **Deciders:** Caleb
- **Backfilled:** yes, 2026-11-24, from `main.js` (`initTCP`, `_sendRaw`, `rpc`, `handshake`, `_onData`, `_handleServerRequest`), `companion/HELP.md`, commits 22e256e and acf1cf5
- **Related:** ADR 0001

## Context

The module has to list and recall snapshots, layouts, windows and inputs on a VIP-X (ADR 0001). The VIP-X control interface it uses is "TCP JSON-RPC 2.0 (default 31001)". A handshake is "required on connect", and the "VIP-X pings ~5s; module replies automatically" (`companion/HELP.md`).

## Options considered

None recorded. Rationale not recorded at the time.

## Decision

- **Transport:** one TCP connection per instance through Companion's `TCPHelper`. The host and port come from the module config (port default 31001) (`getConfigFields`, `initTCP`).
- **Framing:** each JSON-RPC 2.0 message is one JSON object followed by `\r\n`, in both directions (`_sendRaw`, `_onData`).
- **Handshake:** on connect the module calls `handshake` with `client_supported_versions: [1, 2]` and records the negotiated version in the `handshake_version` variable. Every other RPC waits in an outbound queue until the handshake completes, and the instance stays "Connecting" until then (`rpc`, `handshake`).
- **Server messages:** after the handshake the module answers the VIP-X's `ping` with `pong`. `notify_*` messages (for example `notify_delete_snapshot`) update the cached lists (`_handleServerRequest`).
- **Discovery:** `refreshAll` fetches displays, layouts and snapshots, then each display's windows and inputs, and rebuilds the action choices from them.

## Consequences

- Behaviour depends on the VIP-X's JSON-RPC method set and on interface versions 1 and 2. A firmware that drops both versions, or renames methods, breaks the module.
- Creating or saving snapshots is not exposed by the VIP-X JSON-RPC, so the module can only recall snapshots made on the multiviewer (`companion/HELP.md`).
- On disconnect the queue and handshake state are cleared, and Companion's `TCPHelper` handles reconnecting.
- Wire debug logging (`_wireDebug`) is on by default and logs every message in both directions.
