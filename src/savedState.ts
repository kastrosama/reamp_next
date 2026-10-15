import { File, Paths } from 'expo-file-system';

// Remembers the player between launches: the last skin, the playlist (with
// the last-played track) and which windows are open or shaded. Stored as
// files in the app's private documents folder.

export type SavedTrack = {
  url: string;
  name?: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number | null;
  live?: boolean;
};
export type SavedState = {
  version: 1;
  tracks: SavedTrack[];
  current: number; // index into tracks, -1 = none
  windows: Record<'main' | 'equalizer' | 'playlist', { open: boolean; shade: boolean }>;
};

const stateFile = () => new File(Paths.document, 'player-state.json');
const skinFile = () => new File(Paths.document, 'skin.wsz');

/** Read synchronously at startup so the page can start with it. */
export function loadSaved(): { state: SavedState | null; skinB64: string | null } {
  let state: SavedState | null = null;
  let skinB64: string | null = null;
  try {
    const f = stateFile();
    if (f.exists) {
      const parsed = JSON.parse(f.textSync());
      if (parsed && parsed.version === 1 && Array.isArray(parsed.tracks)) state = parsed;
    }
  } catch {
    state = null;
  }
  try {
    const f = skinFile();
    if (f.exists) skinB64 = f.base64Sync();
  } catch {
    skinB64 = null;
  }
  return { state, skinB64 };
}

export function saveState(state: SavedState) {
  try {
    const f = stateFile();
    if (!f.exists) f.create();
    f.write(JSON.stringify(state));
  } catch (e) {
    console.warn('[saved-state] could not save', e);
  }
}

export function saveSkin(b64: string | null) {
  try {
    const f = skinFile();
    if (!b64) {
      if (f.exists) f.delete();
      return;
    }
    if (!f.exists) f.create();
    f.write(b64, { encoding: 'base64' });
  } catch (e) {
    console.warn('[saved-state] could not save skin', e);
  }
}
