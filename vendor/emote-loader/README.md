# E-mote loader artifacts

Each `<platform>-<arch>/` directory is an **independent, checked-in copy** of the
native loader, its source revision, binary SHA-256, and licenses. No symlinks,
submodules, adjacent checkout, Rust installation, or network access are required
by normal `npm run build`, `npm run dev`, or the packaged application.

Currently supplied: **macOS arm64**, source revision
`3310e6008266793da89a564e764bbbdbd31e26a2` (Apache-2.0).

Maintainers explicitly update artifacts with Git, Cargo and the native toolchain:

```bash
npm run emote:loader -- /path/to/amadeus-emote-loader <commit>
```

The command exports the selected Git commit into a temporary directory, ignores
uncommitted upstream changes, builds only `emote-loader` with `--locked`, and
records the compiler target and binary checksum. Commit the entire resulting
directory together. Build on the target OS/architecture; cross-packaging an app
with a different architecture's loader is not supported.

`build` and `dev` validate the manifest and checksum before copying into
`dist/bin`. A missing artifact allows the app shell to start with a recoverable
scene error; an invalid artifact fails the build. Release packaging uses
`--require-emote`, so a missing artifact cannot silently produce an incomplete
release. Binaries and their notices ship outside `app.asar`.

This parser does **not** include the FreeMote runtime or character artwork; their
separate import and redistribution restrictions remain unchanged.
