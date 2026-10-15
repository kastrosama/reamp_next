import { Directory, File } from 'expo-file-system';

// Formats Android's player (ExoPlayer) can play.
const AUDIO_EXT = /\.(mp3|flac|ogg|oga|opus|m4a|m4b|mp4|aac|wav|aif|aiff|mka|webm|3gp|amr)$/i;
const MAX_FILES = 3000;
const MAX_DEPTH = 6;

export type PickedItem = { url: string; name: string };
export type PickedBlob = { name: string; b64: string; type: string };
export type PickResult = { items?: PickedItem[]; files?: PickedBlob[] };

/** Natural sort so "Track 2" comes before "Track 10". */
const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/** Music files: the system file picker, filtered to audio, multi-select. */
async function pickAudioFiles(): Promise<PickResult> {
  const res = await File.pickFileAsync({ mimeTypes: ['audio/*'], multipleFiles: true });
  if (res.canceled || !res.result) return { items: [] };
  return { items: res.result.map((f) => ({ url: f.uri, name: f.name })) };
}

/**
 * A folder: the system folder picker, then every audio file inside it and
 * its sub-folders (folder by folder, files sorted by name, like Winamp).
 */
async function pickAudioFolder(): Promise<PickResult> {
  let root: Directory;
  try {
    root = await Directory.pickDirectoryAsync();
  } catch {
    return { items: [] }; // cancelled
  }
  const items: PickedItem[] = [];
  const walk = (dir: Directory, depth: number) => {
    if (items.length >= MAX_FILES || depth > MAX_DEPTH) return;
    let entries: (Directory | File)[] = [];
    try {
      entries = dir.list();
    } catch {
      return;
    }
    const files = entries.filter((e): e is File => e instanceof File && AUDIO_EXT.test(e.name)).sort(byName);
    for (const f of files) {
      if (items.length >= MAX_FILES) return;
      items.push({ url: f.uri, name: f.name });
    }
    entries
      .filter((e): e is Directory => e instanceof Directory)
      .sort(byName)
      .forEach((d) => walk(d, depth + 1));
  };
  walk(root, 0);
  return { items };
}

/** Small files the player reads itself (EQ presets, skins), sent as base64. */
async function pickSmallFile(): Promise<PickResult> {
  const res = await File.pickFileAsync({ mimeTypes: '*/*' });
  if (res.canceled || !res.result) return { files: [] };
  const f = res.result;
  return { files: [{ name: f.name, b64: await f.base64(), type: f.type ?? '' }] };
}

/**
 * Answers the player's "open file" requests.
 * - accept null + directory  -> Add dir
 * - accept null              -> Add file / Eject (music)
 * - accept set (.eqf, .wsz)  -> preset or skin file
 */
export async function handlePick(accept: string | null, directory: boolean): Promise<PickResult> {
  try {
    if (accept) return await pickSmallFile();
    if (directory) return await pickAudioFolder();
    return await pickAudioFiles();
  } catch (e) {
    console.warn('[pickers]', e);
    return { items: [], files: [] };
  }
}
