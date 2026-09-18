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

Runtime resources are included in `resources/`: the complete character pack,
room images, sound effect, renderer scripts, texture decoders, and CRT geometry.
Development reads that directory; the macOS app bundles it as `amadeus-assets`.
No external asset path is needed. The scene/settings components, localization,
and styles are owned locally under `src/renderer/`.

The Fish credentials can be configured in the environment (`FISH_API_KEY`,
`FISH_VOICE_ID`, and optionally `FISH_API_MODEL`) or in the scene settings.

The app uses a separate Electron user-data store, so it starts with its own
session history and never rewrites the legacy `sessions/` data.

Optional overrides remain available: `SALIERI_NEXT_PROJECT_ROOT` selects another
resource root with the same layout, and `SALIERI_NEXT_CHARACTER_ROOT` selects
another character pack. Missing clips are diagnosed and excluded from the graph;
an available idle clip remains usable. See `resources/README.md` for the inventory.

## Character and voice ownership

The main process owns Pi/ASR/Fish connections and the active conversation turn.
The scene owns audio playback and the character graph. React forwards typed
messages through a validated MessageChannel; it does not schedule animation.
Every turn has a session ID, turn ID, and generation. Switching sessions,
stopping, or losing the scene invalidates old audio and callbacks.

`src/shared/character.ts` contains the pure graph transition and one character
behavior table. The existing Pixi drawing, lazy texture loading, authored clip
timing, and mouth masks are reused. The main process loads all pack resources
through `src/main/characterPack.ts`; no Python animation runtime is required.

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

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:electron
```

The Electron acceptance check uses an isolated temporary user-data directory
and generated PCM. It exercises the production IPC/MessageChannel, real audio
output, emotion cues, drain, post-speech exit, and stale-generation rejection.
It makes no paid API calls and does not open the microphone.
`npm run test:scene` serves the scene separately for visual inspection.

Live Fish synthesis requires configured credentials; live Apple Speech still
requires macOS microphone/speech authorization and actual speech input.
