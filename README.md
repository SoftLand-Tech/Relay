# Hermes Pocket

Expo (SDK 57) mobile client for a self-hosted Hermes gateway. Same JSON-RPC
protocol as the desktop app, plus the dashboard REST audio endpoints.

## Pair the phone (2 min)

On the PC that runs the gateway:

```sh
./scripts/hermes-pair.sh --host 192.168.1.10 --port 9999
# Tailscale/production:
./scripts/hermes-pair.sh --host myhost.tailnet.ts.net --tls
```

It prints the host/token plus a QR. On the phone: open Hermes Pocket →
**Scan pairing QR** (or paste the `hermes://connect?…` link). Token lands in
SecureStore, never in git.

## Voice (STT + TTS via your gateway)

No audio API keys on the phone. The app relays through the gateway, so
whatever the server runs (Deepgram, Whisper, Edge…) just works:

- mic button in chat → record (m4a, 2-min cap) → `POST /api/audio/transcribe`
  → transcript lands in the composer for review → send.
- **Listen** on any reply → `POST /api/audio/speak` → plays the server voice
  (Android plays everything; iOS falls back to on-device speech for
  ogg/opus, which AVPlayer can't decode).

## Push for approvals

Two layers:

1. **Local alerts (no setup).** While the socket is alive but the app is
   backgrounded, approvals / sudo / secrets / questions / replies raise a
   system notification. Tap → back to chat. Toggle in Settings.
2. **Remote push (app closed).** Needs a build with push credentials:
   - `npx eas init` in this dir, then `eas build` (dev at least). Expo Go
     cannot receive remote pushes on Android.
   - iOS release needs an APNs key in EAS (see Expo push-setup docs).
   - On the phone: Settings → **Get push token** (copies it).
   - On the PC/server, keep the watcher running (systemd/tmux):
     ```sh
     ./scripts/hermes-push-watch.sh \
       --host 127.0.0.1:9119 \
       --push-token 'ExponentPushToken[xxxx]' \
       # --replies   # also push on every agent reply (noisy, off by default)
     ```
     The watcher polls the lossless replay ring (`session.events.since` —
     read-only, steals no sessions) and forwards approvals/questions to
     Expo Push. First run seeds watermarks silently.

## Slash commands

Type `/` in the composer. The palette is driven by the gateway's own registry —
`commands.catalog` (127 commands on a current build) and `complete.slash` for
ranking — so nothing is hardcoded and new commands show up without an app
update. Skills registered on the server appear in the same list.

Dispatch mirrors the gateway's stage order: quick command → plugin → bundle →
skill → built-in. Built-ins run through `slash.exec` (`command.dispatch` answers
`4018` for them, which the app treats as "fall through", not an error).

## Multi-session

Each conversation is an independent `SessionState`: its own messages, tool
calls, thinking, todos, usage, busy flag, pending questions, and cached
transcript. The UI renders the *active* session via computed stores, so
switching conversations never mixes streams, and a turn running in session A
keeps ticking (with a dot in the session list) while you read session B.

`session.list` returns durable **stored** ids while RPCs and events are keyed by
**live** ids, so the app keeps a live→stored map and bridges the two. Server
requests carry their own `session_id` and are queued per session — a question
for a background conversation shows up in the tab badge instead of blocking the
chat you're reading.

## Protocol

`src/protocol/` is a port of the upstream shared client
(`~/.hermes/hermes-agent/apps/shared/src/`), split the same way:

- `json-rpc-channel.ts` — transport-agnostic: request ids, pending map, event
  decoding, **server→client requests**, `client.capabilities` advertisement, and
  the `gateway.ping` heartbeat
- `json-rpc-gateway.ts` — WebSocket lifecycle + the lossless seq/epoch replay
  contract

The current protocol is **v7**: approval / clarify / sudo / secret arrive as
JSON-RPC *requests* (id `srq-<hex>`) answered by a response frame with the same
id. There is no `*.request` notification and no `*.respond` method —
`clarify.respond`, `sudo.respond` and `secret.respond` answer `-32601`.

Param contracts are `extra="forbid"`: an unknown key is rejected with `4000`.
That is why `session.create` / `session.resume` must not send `rows`, and
`session.list` has no `search` key.

## Verify

```sh
npm run typecheck   # app + scripts
npm run test        # 25 protocol assertions against a fake v7 gateway
npm run test:live   # 16 assertions against the real hermes serve
npm run verify      # all of the above
```

`npm test` needs no gateway: it stands up a local server that speaks the v7
wire contract and checks the approval round trip, the `-32601`/`-32603` failure
paths, per-session seq isolation, and reconnect replay with `open_requests`.

`npm run test:live` needs `hermes serve` running and reads the token from
`~/.config/hermes-serve.env` (override with `HERMES_SERVE_ENV`). It creates
and deletes its own sessions.

## Production checklist

- `eas.json` exists; set `extra.eas.projectId` via `npx eas init`.
- `app.json` has `com.hermes.pocket` ids, camera/mic strings, notifications
  plugin (`hermes-alerts` channel).
- `npm run verify` clean.
