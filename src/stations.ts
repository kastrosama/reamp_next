// Starter stations for the proof of concept. Later this can come from the
// Reamp station database.
export type Station = { name: string; url: string; genre?: string };

export const STATIONS: Station[] = [
  { name: 'SomaFM Groove Salad', genre: 'Ambient / Downtempo', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { name: 'Radio Paradise Main Mix', genre: 'Eclectic', url: 'https://stream.radioparadise.com/mp3-128' },
  { name: 'SomaFM Drone Zone', genre: 'Ambient', url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { name: 'SomaFM Secret Agent', genre: 'Lounge', url: 'https://ice1.somafm.com/secretagent-128-mp3' },
  { name: 'SomaFM DEF CON Radio', genre: 'Electronic', url: 'https://ice1.somafm.com/defcon-128-mp3' },
  { name: 'SomaFM Indie Pop Rocks!', genre: 'Indie', url: 'https://ice1.somafm.com/indiepop-128-mp3' },
];
