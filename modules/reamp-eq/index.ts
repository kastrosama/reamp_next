import { requireOptionalNativeModule } from 'expo-modules-core';
import type { AudioPlayer } from 'expo-audio';

type ReampEqNative = {
  attach(player: AudioPlayer): Promise<number>;
  setBand(index: number, db: number): void;
  setPreamp(db: number): void;
  setEnabled(on: boolean): void;
};

// Optional so the app still runs (without EQ) if the native side is missing.
const native = requireOptionalNativeModule<ReampEqNative>('ReampEq');

/** Winamp's band order: 60, 170, 310, 600, 1k, 3k, 6k, 12k, 14k, 16k Hz. */
export const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;

/** Webamp sliders are 0..100 with 50 = 0 dB, spanning -12..+12 dB. */
export const sliderToDb = (v: number) => (v / 100) * 24 - 12;

export const ReampEq = {
  available: native != null,
  attach: (player: AudioPlayer) => native?.attach(player) ?? Promise.resolve(0),
  setBand: (index: number, db: number) => native?.setBand(index, db),
  setPreamp: (db: number) => native?.setPreamp(db),
  setEnabled: (on: boolean) => native?.setEnabled(on),
};
