# Remote Control secure channel v1

The secure channel uses platform WebCrypto primitives: P-256 ECDSA/SHA-256 for identity signatures, ephemeral P-256 ECDH for each connection, HKDF/SHA-256 for directional keys, and AES-256-GCM for frames. iOS uses matching CryptoKit primitives. Private device keys require protected local storage; ephemeral agreement keys are never reused across handshakes.

An authenticated channel does not authorize a project or operation. The Agent must resolve the verified device key to a current Grant before accepting application data, then check operation, target, expiry and revocation version on every request. Unknown device keys require local pairing approval.

## Handshake

Binary fields use canonical unpadded base64url. P-256 public keys are 65-byte uncompressed points; signatures are 64-byte IEEE P1363 `r || s`, not DER. Challenges are 32 random bytes. Object keys are sorted lexicographically before compact JSON serialization. Handshake fields contain only ASCII identifiers and encoded bytes.

The client signs `["miao.control.client.v1", clientPayload]`. The payload includes version, host/runtime identities, device signing public key, ephemeral agreement key and challenge. The signature is added to produce the client hello.

The Agent verifies the signature against an already authorized device key. It signs `["miao.control.server.v1", clientHello, serverPayload]`. Its payload includes version, host/runtime identities, allocated connection identity, host signing public key, ephemeral agreement key, fresh challenge and the client's challenge. The signature is added to produce the server hello.

The client verifies the host signing key against the locally paired trust anchor, validates both target identities and its challenge, then verifies the signature. Keys supplied only by the Hub are never trusted. A client handshake finishes once only.

Both sides derive a 32-byte ECDH shared secret. HKDF salt is SHA-256 of canonical `[clientHello, serverHello]`. HKDF info is canonical `["miao.control.channel.v1", direction]`, where direction is `client-to-host` or `host-to-client`. Each output is a distinct 32-byte AES key. Fresh ephemeral keys and signed challenges bind keys to this connection.

## Frames

The binary frame is version byte `1`, unsigned 64-bit big-endian sequence, ciphertext, then a 16-byte GCM tag. The nine-byte header is authenticated additional data. The 12-byte nonce is four zero bytes followed by the eight sequence bytes; sequences start at one. Directional keys prevent reflection. New connections use fresh keys, so they never reuse an old key/nonce pair.

The receiver accepts only its next sequence and advances only after successful authentication. Receive and send operations serialize within each channel. Replays, reordering, modified packets and frames from another channel are rejected. A failed send or lost frame requires reconnect/resynchronization; it does not authorize application-level replay.

Plaintext is limited to 128 KiB and encoded frames to 180 KiB. The transport accepts base64url as an opaque envelope. Public handshake keys and routing/timing metadata are visible to the relay; session contents are encrypted after handshake.
