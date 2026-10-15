// Patches the bundled player engine when it's copied into the app:
// rebrands user-visible text and links for Reamp, enables the EQ "Auto"
// button (the engine ships with it disabled) and routes file dialogs to
// Android's own pickers.
//
// The engine is Webamp (MIT licensed). Its licence notice is kept in
// THIRD_PARTY_NOTICES.md, as the MIT licence requires; only the in-app
// branding is changed here.
const REPLACEMENTS = [
  // Long-press / main menu entry and the lightning-bolt "about" link.
  ['label:"Webamp..."', 'label:"Reamp..."'],
  ['"https://webamp.org/about"', '"https://reamp.app/"'],
  // Messages shown for features that aren't available.
  ['"Not supported in Webamp"', '"Not supported in Reamp"'],
  // EQ "Auto" button: the engine always forces it off. Make it a real
  // toggle; Reamp then picks a preset per station (see web/bridge.js).
  [
    'return e=>{e({type:"SET_EQ_AUTO",value:!1})}',
    'return(e,t)=>{e({type:"SET_EQ_AUTO",value:!t().equalizer.auto})}',
  ],
  // File dialogs (Add file, Add dir, Eject, load EQ preset/skin): the
  // browser file input only offers camera/photos inside an Android WebView,
  // so hand the request to Reamp's native pickers when available.
  [
    'directory:!1}){return new Promise(n=>{const a=document.createElement("input");',
    'directory:!1}){if(window.__pickFiles)return window.__pickFiles({accept:e,directory:t});return new Promise(n=>{const a=document.createElement("input");',
  ],
  // Picked music files arrive as references to device files (content://),
  // which the native player streams directly, rather than in-memory blobs.
  [
    '.map(e=>({blob:e,defaultName:e.name}))',
    '.map(e=>e.__url?{url:e.__url,defaultName:e.name}:{blob:e,defaultName:e.name})',
  ],
];

function patchPlayer(source) {
  let out = source;
  for (const [from, to] of REPLACEMENTS) {
    if (!out.includes(from)) {
      throw new Error(`patchPlayer: expected text not found (player engine changed?): ${from}`);
    }
    out = out.split(from).join(to);
  }
  return out;
}

module.exports = { patchPlayer };
