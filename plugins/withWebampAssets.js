// Copies the WebView player (web/) plus the Webamp bundle into the Android
// assets folder during `expo prebuild`, so the WebView can load it from
// file:///android_asset/web/index.html with no network or dev server.
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

module.exports = function withWebampAssets(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const root = cfg.modRequest.projectRoot;
      const dest = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'web');
      copyDir(path.join(root, 'web'), dest);
      const bundle = require.resolve('webamp', { paths: [root] }); // -> built/webamp.bundle.min.js (UMD)
      fs.copyFileSync(bundle, path.join(dest, 'webamp.bundle.min.js'));
      return cfg;
    },
  ]);
};
