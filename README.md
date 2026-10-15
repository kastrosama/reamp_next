# Reamp Next

The next Reamp: a classic skinnable player UI running in a WebView, with audio
played natively by `expo-audio`, so radio keeps going in the background and on
the lock screen.

## How it fits together

- `web/` — the page loaded in the WebView. `bridge.js` hands the player engine
  a custom media class that forwards play/pause/load/volume/EQ to native, keeps
  the windows laid out full-width, drives the visualizer, keeps menus on
  screen, and picks EQ presets per station when "Auto" is on.
- `App.tsx` — hosts the WebView, plays streams with `expo-audio`, and pushes
  playback status back into the page. Lock-screen pauses are synced to the UI.
- `modules/reamp-eq/` — local Expo module: 10-band EQ + preamp on the player's
  audio session (Android DynamicsProcessing; Equalizer fallback).
- `plugins/withPlayerAssets.js` — copies `web/` and the player engine into the
  Android assets during `expo prebuild`; `plugins/patchPlayer.js` rebrands the
  engine for Reamp and enables the EQ Auto toggle.
- `src/stations.ts` — starter station list (genre drives Auto EQ).

## Getting the APK

Every push to `main` builds a release APK on GitHub Actions and attaches it to a
new release (`build-N`). Open the repo's **Releases** page on your phone and tap
the `.apk`.

## Credits

The player engine is Webamp (MIT). Its licence notice must ship with the app —
see `THIRD_PARTY_NOTICES.md`.

## Known gaps

- Uses the engine's built-in default skin, which is Winamp artwork, and its
  title bars read "WINAMP". Replace with an original skin before any Play
  Store release.
