// Registers Reamp with Android as something that can open:
//   - audio files (shows in "Open with", can be set as the default player)
//   - .m3u / .pls playlists
//   - .wsz Winamp skins
// The app handles the opened file in App.tsx (see handleOpened).
const { withAndroidManifest } = require('expo/config-plugins');

const AUDIO_MIME = ['audio/*', 'application/ogg', 'application/x-ogg', 'application/x-flac'];
const PLAYLIST_MIME = [
  'audio/x-mpegurl', 'audio/mpegurl', 'application/x-mpegurl', 'application/mpegurl',
  'audio/x-scpls', 'audio/scpls', 'application/pls+xml',
];
const SKIN_MIME = ['application/x-winamp-skin', 'interface/x-winamp-skin'];
// Many file managers don't know these extensions and send a generic type, so
// also match by file name.
const BY_EXTENSION = ['wsz', 'm3u', 'pls'];

const action = { $: { 'android:name': 'android.intent.action.VIEW' } };
const categories = [
  { $: { 'android:name': 'android.intent.category.DEFAULT' } },
  { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
];

function mimeFilter(mimes) {
  return {
    action: [action],
    category: categories,
    data: mimes.flatMap((m) => [
      { $: { 'android:scheme': 'content', 'android:mimeType': m } },
      { $: { 'android:scheme': 'file', 'android:mimeType': m } },
    ]),
  };
}

function extensionFilter(withMime) {
  // Android matches a dot only in the last few path segments with these
  // patterns, so cover a few directory depths.
  const patterns = BY_EXTENSION.flatMap((ext) => [
    `.*\\\\.${ext}`, `.*\\\\..*\\\\.${ext}`, `.*\\\\..*\\\\..*\\\\.${ext}`,
  ]);
  return {
    action: [action],
    category: categories,
    data: [
      { $: { 'android:scheme': 'content' } },
      { $: { 'android:scheme': 'file' } },
      { $: { 'android:host': '*' } },
      ...(withMime ? [{ $: { 'android:mimeType': '*/*' } }] : []),
      ...patterns.map((p) => ({ $: { 'android:pathPattern': p } })),
    ],
  };
}

module.exports = function withOpenWith(config) {
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application[0];
    const main = app.activity.find((a) => a.$['android:name'] === '.MainActivity');
    main['intent-filter'] = main['intent-filter'] || [];
    main['intent-filter'].push(
      mimeFilter(AUDIO_MIME),
      mimeFilter(PLAYLIST_MIME),
      mimeFilter(SKIN_MIME),
      extensionFilter(false),
      extensionFilter(true),
    );
    return cfg;
  });
};
