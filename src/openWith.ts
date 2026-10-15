import { File } from 'expo-file-system';

// Handles files opened in Reamp from other apps ("Open with" / default
// player): audio files, .m3u/.pls playlists and .wsz skins.

export type OpenedItem = { url: string; name: string; live?: boolean };
export type Opened =
  | { kind: 'audio'; items: OpenedItem[] }
  | { kind: 'playlist'; items: OpenedItem[] }
  | { kind: 'skin'; name: string; b64: string }
  | { kind: 'none' };

function describe(uri: string): { name: string; type: string } {
  let name = '';
  let type = '';
  try {
    const f = new File(uri);
    name = f.name || '';
    type = f.type || '';
  } catch {
    // fall back to the URI below
  }
  if (!name) {
    try {
      name = decodeURIComponent(uri).split(/[/:]/).pop() || uri;
    } catch {
      name = uri;
    }
  }
  return { name, type: type.toLowerCase() };
}

const isAbsolute = (u: string) => /^(https?|content|file):\/\//i.test(u);

/** Parses .m3u / .m3u8 / .pls text into playable entries (absolute ones only). */
export function parsePlaylist(text: string, nameHint = ''): OpenedItem[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  const items: OpenedItem[] = [];
  if (/^\[playlist\]/i.test(lines.find((l) => l) ?? '') || /\.pls$/i.test(nameHint)) {
    const files: Record<string, string> = {};
    const titles: Record<string, string> = {};
    for (const l of lines) {
      const f = /^File(\d+)\s*=\s*(.+)$/i.exec(l);
      const t = /^Title(\d+)\s*=\s*(.+)$/i.exec(l);
      if (f) files[f[1]] = f[2];
      if (t) titles[t[1]] = t[2];
    }
    Object.keys(files)
      .sort((a, b) => Number(a) - Number(b))
      .forEach((k) => {
        if (isAbsolute(files[k])) items.push({ url: files[k], name: titles[k] || files[k] });
      });
    return items;
  }
  let title = '';
  for (const l of lines) {
    if (!l) continue;
    const inf = /^#EXTINF:[^,]*,(.*)$/i.exec(l);
    if (inf) {
      title = inf[1].trim();
      continue;
    }
    if (l.startsWith('#')) continue;
    if (isAbsolute(l)) items.push({ url: l, name: title || l });
    title = '';
  }
  return items;
}

/** Works out what was opened and reads whatever the player needs. */
export async function readOpened(uri: string): Promise<Opened> {
  if (!uri || !/^(content|file):/i.test(uri)) return { kind: 'none' };
  const { name, type } = describe(uri);

  if (/\.(wsz)$/i.test(name) || type.includes('winamp-skin')) {
    const b64 = await new File(uri).base64();
    return { kind: 'skin', name, b64 };
  }
  if (/\.(m3u8?|pls)$/i.test(name) || /mpegurl|scpls|pls\+xml/.test(type)) {
    const text = await new File(uri).text();
    const items = parsePlaylist(text, name).map((it) => ({ ...it, live: /^https?:/i.test(it.url) }));
    return { kind: 'playlist', items };
  }
  return { kind: 'audio', items: [{ url: uri, name }] };
}
