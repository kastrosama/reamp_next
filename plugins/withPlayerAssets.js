// Copies the WebView player (web/) plus the player engine into the Android
// assets folder during `expo prebuild`, so the WebView can load it from
// file:///android_asset/web/index.html with no network or dev server.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');
const { patchPlayer } = require('./patchPlayer');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

/** Writes the patched, rebranded player engine to `dest/player.js`. */
function writePlayerEngine(root, dest) {
  // The engine is the `webamp` npm package (MIT); see THIRD_PARTY_NOTICES.md.
  const engine = require.resolve('webamp', { paths: [root] }); // UMD build
  fs.writeFileSync(path.join(dest, 'player.js'), patchPlayer(fs.readFileSync(engine, 'utf8')));
}

function withPlayerAssets(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'web');
      copyDir(path.join(root, 'web'), dest);
      writePlayerEngine(root, dest);
      return cfg;
    },
  ]);
}

module.exports = withPlayerAssets;
module.exports.writePlayerEngine = writePlayerEngine;
