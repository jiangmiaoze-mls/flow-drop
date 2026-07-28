# Agent To Android V3 Download Protocol

This protocol adds `Agent -> Android` transfer without changing the existing
`mobile -> Agent` V3 upload routes. WebSocket messages contain metadata only;
Android Kotlin downloads file bytes directly from the Agent.

## Identity And Realtime Session

The mobile root runtime keeps a WebSocket to `ws://agent/v1/peer`. After
`peer.hello`, it sends `peer.authenticate` with an Authorization value signed
over these exact UTF-8 bytes:

```text
WS\n/v1/peer\nTIMESTAMP\nNONCE\nSHA256(canonicalPeerHelloJson)
```

`canonicalPeerHelloJson` is exactly:

```json
{"deviceId":"...","deviceKind":"mobile","deviceName":"..."}
```

The Agent emits a `file.offer` WebSocket message only to an authenticated
connection whose device ID matches the offer recipient.

## Agent Routes

All routes use the existing `FlowDrop-HMAC` request signature and the source
device ID header. `transferId`, `itemId`, and `chunkIndex` are immutable.

```text
GET  /v3/outgoing-transfers/:transferId/status
GET  /v3/outgoing-transfers/:transferId/items/:itemId/chunks/:chunkIndex
POST /v3/outgoing-transfers/:transferId/items/:itemId/chunks/:chunkIndex/ack
POST /v3/outgoing-transfers/:transferId/pause
POST /v3/outgoing-transfers/:transferId/resume
POST /v3/outgoing-transfers/:transferId/cancel
```

The status and chunk endpoint reject a request from any device other than the
persisted recipient. A chunk response is raw bytes with `Content-Range` and
`X-FlowDrop-Chunk-Sha256`; no byte array is returned through WebSocket or JS.

`ack` uses canonical JSON:

```json
{"sha256":"lowercase-hex","sizeBytes":123}
```

It advances the Agent revision only after the Android durable acknowledgement.
The Agent never deletes its source file before every item is completed.

## Offer

```json
{
  "transferId":"...",
  "revision":1,
  "chunkSizeBytes":1048576,
  "items":[{
    "itemId":"...",
    "name":"...",
    "mimeType":"...",
    "sizeBytes":123,
    "contentRoot":"lowercase-hex"
  }]
}
```

The offer is idempotent by `transferId`. A reconnect receives outstanding
offers after WebSocket authentication before live events are accepted.

## Android Receive Controller

`ReceiveController` is Application-scoped and runs on `Dispatchers.IO`. It
creates an app-private `.part` file, streams each authenticated chunk into its
offset, hashes it, validates the advertised digest, then POSTs `ack`. It emits
the existing metadata-only transfer events and writes the same SQLite
projection shape used by uploads. On completion it rebuilds `contentRoot`,
atomically publishes to MediaStore, and reports `completed`.

Pause, resume, cancel, process recovery, revision monotonicity, and failed
content roots have the same semantics as upload V3. JavaScript never reads
file bytes.
