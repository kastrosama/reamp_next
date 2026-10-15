# Reamp Next

Proof of concept for the next Reamp: the [Webamp](https://github.com/captbaritone/webamp)
player UI (MIT) running in a WebView, with audio played natively by `expo-audio`
so radio keeps going in the background and on the lock screen.

## How it fits together

- `web/` — the page loaded in the WebView. `bridge.js` gives Webamp a custom
  media class (`__customMediaClass`) that forwards play/pause/load/volume to
  native instead of playing audio in the browser.
- `App.tsx` — hosts the WebView, plays streams with `expo-audio`, and pushes
  playback status back into the page. Lock-screen pauses are synced to the UI.
- `plugins/withWebampAssets.js` — copies `web/` and the Webamp bundle into the
  Android assets during `expo prebuild`.
- `src/stations.ts` — starter station list.

## Getting the APK

Every push to `main` builds a release APK on GitHub Actions and attaches it to a
new release (`build-N`). Open the repo's **Releases** page on your phone and tap
the `.apk`.

## Known gaps (proof of concept)

- Equalizer sliders move but don't change the sound yet (needs a native EQ module).
- Visualizer is simulated; real audio capture would need the microphone permission.
- Uses Webamp's built-in default skin, which is Winamp artwork. Replace it with
  an original skin before any Play Store release, and don't use the Winamp name.
