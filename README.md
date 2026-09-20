# Salieri Next

This is the standalone TypeScript/Electron project for the Amadeus scene shell.
All application source, build configuration, tests, and local runtime resources
live in this project; building and running it does not require the legacy Salieri
repository.

It keeps the existing scene renderer and character assets, embeds the native Pi
SDK in an Electron utility process, uses Apple Speech for macOS recognition, and
streams Fish Audio PCM and word timestamps over its WebSocket TTS API. It does not start the legacy
Python backend.

Pi reads its own model and credential configuration from the normal Pi agent
directory; Salieri does not add a provider registry around it.

```bash
npm ci
npm run build
npm start
```

Run these commands from this project's directory. For development, use `npm run
dev`. The intended sibling layout is `amadeus-space/Salieri/` and
`amadeus-space/salieri-next/`; the project does not rely on those directory names.

To create the macOS arm64 zip, run `npm run package:mac:zip`. The generated app is
unsigned until a Developer ID certificate is supplied.

Runtime resources live under `resources/`, which the macOS app bundles as
`amadeus-assets`: the character pack, room images, ambient layers, subtitle
frame, renderer scripts, texture decoders, and CRT geometry. Development reads
that directory directly, so no external asset path is needed once the directory
is populated.

Some of those media are deliberately not tracked by Git (the ambient layers,
the subtitle frame, and the whole character pack), so **a fresh clone must be
given the asset payload before a complete scene can run**. See
`resources/README.md` for what is missing and how the runtime degrades without
it. The scene/settings components, localization, and styles are owned locally
under `src/renderer/`.

The Fish credentials can be configured in the environment (`FISH_API_KEY`,
`FISH_VOICE_ID`, and optionally `FISH_API_MODEL`) or in the scene settings.
The Fish model selector includes `s2.1-pro-free`, `s2-pro`, and `s1`. Select
`s2.1-pro-free` explicitly to use Fish's free model, subject to its fair-use
limits. Adding this option does not change existing selections or the default.

The app uses a separate Electron user-data store, so it starts with its own
session history and never rewrites the legacy `sessions/` data.

## Hot updates and component reloads

`npm run dev` starts Vite with React Fast Refresh and watches the main, Pi worker,
preload, scene, native speech helper, and local scene resources. Only successful
builds request a reload; changes are coalesced and routed to the smallest owner:

| Change | Applied by |
|---|---|
| React / CSS | Vite HMR |
| Pi worker code | Replace the utility process after the active turn finishes |
| Scene code, AudioWorklet, images, character pack, CRT geometry | Re-read resources and replace only the scene iframe after playback drains |
| Preload code | Reload the window, keeping the main process and Pi alive |
| Swift / speech Info.plist | Recompile and replace only the speech helper |
| Main-process code | Checkpoint Pi, exit with code 75, and let the development launcher restart Electron |

Use `npm run dev -- --port=5207` for another port, or add `--server-only` to run
the development server and build watchers without launching Electron. Production
does not accept development restart commands.

Settings apply through the existing runtime IPC, not through a process restart.
Fish credentials/model/voice apply to the next synthesis; calibration changes
apply during playback. Recognition language restarts only the recognition task.
The Models page selects the current Pi session's model and thinking level while
Pi is idle, using the SDK registry rather than a second provider configuration.

Resource reload and component recovery are internal runtime mechanisms, not
user-facing settings. The runtime retains `runtime.reload` and `runtime.status`
IPC for infrastructure and integration checks; development watchers trigger the
appropriate reload automatically. The settings page exposes no maintenance panel
or manual recovery buttons.
Environment variables remain startup inputs; changing a shell's environment does
not change an already running app.

Reload waits for both the Pi turn and audible playback to finish. New chat
requests are rejected with a visible explanation while maintenance is pending;
they are never silently replayed. Abort remains available. A replacement Pi must
complete its initialization handshake before the previous process is retired;
startup failure keeps the previous worker. Invalid scene geometry keeps the
previous snapshot. A lost scene stops speech/microphone capture but lets the
existing Pi turn finish as text. Audio processor failures rebuild audio locally
on the next turn.

Full Pi transcripts (including tools, model choice and thinking level) now live
under `<Electron userData>/pi-sessions/<chat-id>.jsonl`, with private file permissions.
The desktop also remembers the selected chat across restarts. Old desktop history
arrays remain readable, but historical tool context from the former in-memory
worker cannot be reconstructed retroactively. No automatic recovery re-executes
an interrupted tool or prompt.

Optional overrides remain available: `SALIERI_NEXT_PROJECT_ROOT` selects another
resource root with the same layout, and `SALIERI_NEXT_CHARACTER_ROOT` selects
another character pack. Missing clips are diagnosed and excluded from the graph;
an available idle clip remains usable. See `resources/README.md` for the inventory.

## Character and voice ownership

The main process owns Pi/ASR/Fish connections and the active conversation turn.
The scene owns audio playback and the character graph. React forwards typed
messages through a validated MessageChannel; it does not schedule animation.
Every turn has a session ID, turn ID, and generation. Switching sessions or
stopping invalidates old audio and callbacks. Scene replacement has its own
handshake token and does not require replacing the conversation.

`src/scene/index.ts` runs the character state machine (transitions live in
`src/shared/character.ts`) and drives the Pixi sprite driver in
`resources/render/web/renderer.js` through an injected factory. The existing
Pixi drawing, lazy texture loading, authored clip timing, and mouth masks are
reused. The main process loads all pack resources through
`src/main/characterPack.ts`; no Python animation runtime is required.

Pi can annotate a phrase with `[EMO preset=smile]`. The incremental parser strips
valid annotations before display and synthesis, preserves literal code, and
binds cues to text offsets. Fish's `/v1/tts/live/with-timestamp` supplies the
alignment. Playback starts immediately; late corrections never replay audio or
rewind expressions. If normalized text cannot be matched, the current/default
expression continues rather than inventing an alignment.

AudioWorklet reports the samples actually consumed, including buffering and
final drain. Mouth energy is measured there, not at network receipt. The old
receive-side WASM meter and separate React audio queue have been removed.
Calibration values `mouth_gain` (8), `mouth_silence_threshold` (0.08), and
`voice_sync_offset_ms` (0) are persisted through the existing settings API.

Continuous microphone mode submits final recognition once, pauses during the
reply, and resumes only after both Pi and playback complete. Errors keep text
chat available and show a visible explanation.

## Fish failure diagnostics

Fish failures carry a readable cause/action plus a structured `diagnostic` on
both `voice.event` errors and `tts.error`. `provider`, `phase`, and `code` are
always present. HTTP status, network code, WebSocket close code, protocol event,
and bounded `Retry-After` seconds are included when actually observed.
Classification lives in `src/main/fishErrors.ts`; it does not infer a cause from
an arbitrary HTTP body or silently retry a synthesis request.

| Failure evidence | Distinction / suggested action |
|---|---|
| Missing key, non-string settings, invalid header characters, constructor failure | Configuration errors; fix the local value rather than restarting Pi |
| HTTP 400 / 422 | Invalid request parameters; check model, voice and format |
| HTTP 401 | Authentication rejected; check the API key |
| HTTP 402 | Payment requirement; check API credits/billing, not just website membership; does not prove the exact balance |
| HTTP 403 | Account/model access denied |
| HTTP 404 / 405 | Wrong endpoint or method |
| HTTP 407 | Proxy authentication, distinct from Fish authentication |
| HTTP 408 / 504 | Server request timeout / gateway upstream timeout |
| HTTP 413 / 415 / 426 | Request too large / unsupported format / upgrade required |
| HTTP 429 | Rate or concurrency limit; expose valid `Retry-After` without automatically retrying |
| HTTP 500 / 502 / 503 | Internal service error / bad gateway / service unavailable |
| Other 2xx / 3xx / unknown HTTP | Missing WebSocket upgrade / redirect not followed with credentials / unclassified rejection |
| `ENOTFOUND` / `EAI_AGAIN` | Missing DNS resolution / temporary resolver failure |
| Refused, reset, broken pipe, unreachable, timed out | Separate network codes and actions; preserve the phase even after the socket enters `CLOSING` |
| Expired, not-yet-valid, revoked, hostname mismatch, untrusted certificate, other TLS negotiation | Separate TLS failures; never disable certificate verification |
| Invalid Upgrade/Accept header, subprotocol or extensions; invalid WebSocket frames | Opening-protocol versus frame-protocol failures |
| Failed `start`, `text`, or `stop` write | `send_failed` with the specific event and phase; synchronous throws and async write failures do not kill text chat |
| Invalid MessagePack / event envelope / PCM / finish reason | `decode_failed` / `invalid_event` / `invalid_audio` / `invalid_finish` |
| Fish `error` event or `finish(reason=error)` | `service_error`, not a connection failure; include only a credential-redacted, control-character-stripped server message (max 320 characters) |
| No audio after input ends / audio received but no finish | `first_audio_timeout` / `completion_timeout`, after 30s of inactivity; each audio event resets this deadline |
| Close 1000 without Fish finish | Not success: `closed_without_finish` |
| Close 1001–1009, 1011–1013, 1015 | Distinguish peer shutdown, missing/abnormal close, protocol/data/policy/size rejection, server failure/restart/overload, and TLS failure |
| Other close codes | Preserve the code and redacted reason; do not invent authentication or billing diagnoses |

For example, a payment rejection is tagged
`{"provider":"fish","phase":"handshake","code":"payment_required","httpStatus":402}`.
The four phases are `configuration`, `handshake`, `synthesis`, and `completion`.
Long model/tool pauses before text input ends are not treated as Fish timeouts.
Unknown event names are ignored for protocol forward compatibility. Intentional
abort, stale sockets and late callbacks do not produce another failure.
HTTP bodies/headers and raw network exception messages are never forwarded.
Remote Fish failures stop speech but do not destroy a healthy local AudioWorklet
or get echoed back as an unrelated playback failure. Text chat remains available.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:electron
npm run test:dev
```

The Electron acceptance check uses isolated user-data and Pi directories, a local
fake model server, and generated PCM. It exercises the production IPC/MessageChannel,
Pi model selection and context restoration across worker replacement, safe reload
ordering, scene handshakes, live calibration, actual audio playback and processor
recovery. It makes no paid API calls and does not open the microphone.
The development acceptance check copies source into a temporary project and verifies
selective rebuild notifications, React HMR, and failed-build retention without
editing the working tree.
`npm run test:scene` serves the scene separately for visual inspection.

Live Fish synthesis requires configured credentials; live Apple Speech still
requires macOS microphone/speech authorization and actual speech input.
