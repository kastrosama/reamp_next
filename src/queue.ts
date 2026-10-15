// A copy of the playlist kept on the native side, so the next song can be
// started the instant one finishes. That leaves no gap for a car stereo or
// headset to send "play", which Android treats as "restart the song that
// just ended".
//
// The rules match the player engine's own "next" exactly:
//   shuffle  -> a random track other than the current one
//   repeat   -> after the last track, wrap to the first
//   neither  -> after the last track, stop

export type QueueItem = { id: number; url: string; title: string; artist: string; live: boolean };
export type Queue = { items: QueueItem[]; current: number | null; shuffle: boolean; repeat: boolean };

export const emptyQueue: Queue = { items: [], current: null, shuffle: false, repeat: false };

export function nextInQueue(q: Queue, random: () => number = Math.random): QueueItem | null {
  const n = q.items.length;
  if (n === 0) return null;
  if (q.shuffle) {
    let pick: QueueItem;
    do {
      pick = q.items[Math.floor(n * random())];
    } while (pick.id === q.current && n > 1);
    return pick;
  }
  const at = q.items.findIndex((it) => it.id === q.current);
  if (q.repeat) return q.items[(at + 1) % n];
  if (at === n - 1) return null;
  return q.items[Math.max(0, Math.min(n - 1, at + 1))];
}
