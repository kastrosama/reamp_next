import { useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AudioSample,
  AudioStatus,
  createAudioPlayer,
  getRecordingPermissionsAsync,
  requestNotificationPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { STATIONS } from './src/stations';
import { ReampEq, sliderToDb } from './modules/reamp-eq';

type WebMsg =
  | { t: 'ready' }
  | { t: 'log'; msg: string }
  | { t: 'load'; url: string; autoPlay: boolean; title: string }
  | { t: 'play' }
  | { t: 'pause' }
  | { t: 'stop' }
  | { t: 'volume'; v: number }
  | { t: 'seek'; percent: number }
  | { t: 'enableVis' }
  | { t: 'eqBand'; i: number; v: number }
  | { t: 'eqPreamp'; v: number }
  | { t: 'eqOn'; on: boolean };

// The player UI lives in the WebView; audio is played here, natively, so it keeps
// running in the background with lock-screen / notification controls.
const player = createAudioPlayer(null, { updateInterval: 500 });

// Hook the native EQ onto the player's audio session. Retried until it
// succeeds, because the session can be unavailable before first playback.
let eqAttached = false;
const attachEq = () => {
  if (eqAttached) return;
  ReampEq.attach(player)
    .then((id) => { eqAttached = id > 0; })
    .catch(() => {});
};

export default function App() {
  return (
    <SafeAreaProvider>
      <Player />
    </SafeAreaProvider>
  );
}

function Player() {
  const insets = useSafeAreaInsets();
  const webRef = useRef<WebView>(null);
  const titleRef = useRef('Reamp Next');
  // Set when the web UI itself asked to pause/stop/load, so we can tell those
  // apart from pauses coming from the lock screen or headphones.
  const lastWebCommandAt = useRef(0);
  const wasPlaying = useRef(false);

  const send = (payload: object) =>
    webRef.current?.injectJavaScript(
      `window.__fromNative && window.__fromNative(${JSON.stringify(payload)}); true;`,
    );

  // Real visualizer: Android's Visualizer API needs the RECORD_AUDIO
  // permission even though nothing is recorded. Opt-in, from a tap.
  const startRealVisualizer = () => {
    player.setAudioSamplingEnabled(true);
    send({ t: 'visEnabled', on: true });
  };
  const askForRealVisualizer = async () => {
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (granted) startRealVisualizer();
      else send({ t: 'visEnabled', on: false });
    } catch {
      send({ t: 'visEnabled', on: false });
    }
  };

  useEffect(() => {
    const samples = player.addListener('audioSampleUpdate', (sample: AudioSample) => {
      if (AppState.currentState !== 'active') return;
      const frames = sample.channels[0]?.frames;
      if (!frames?.length) return;
      const d = new Array(frames.length);
      for (let i = 0; i < frames.length; i++) d[i] = Math.round(frames[i] * 127 + 128);
      send({ t: 'samples', d });
    });
    return () => samples.remove();
  }, []);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
    requestNotificationPermissionsAsync().catch(() => {});

    const sub = player.addListener('playbackStatusUpdate', (s: AudioStatus) => {
      const recentWebCommand = Date.now() - lastWebCommandAt.current < 1500;
      const externalPause =
        wasPlaying.current && !s.playing && !s.isBuffering && !s.didJustFinish && !recentWebCommand;
      wasPlaying.current = s.playing;
      if (s.playing) attachEq();
      const payload = {
        t: 'status',
        playing: s.playing,
        isBuffering: s.isBuffering,
        isLoaded: s.isLoaded,
        currentTime: s.currentTime,
        duration: s.isLive ? 0 : s.duration,
        didJustFinish: s.didJustFinish,
        error: s.error,
        externalPause,
      };
      send(payload);
    });
    return () => sub.remove();
  }, []);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: WebMsg;
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'load':
        lastWebCommandAt.current = Date.now();
        titleRef.current = msg.title;
        player.replace({ uri: msg.url });
        player.setActiveForLockScreen(
          true,
          { title: msg.title, artist: 'Reamp Next' },
          { isLiveStream: true, showSeekForward: false, showSeekBackward: false },
        );
        if (msg.autoPlay) player.play();
        attachEq();
        break;
      case 'eqBand':
        ReampEq.setBand(msg.i, sliderToDb(msg.v));
        break;
      case 'eqPreamp':
        ReampEq.setPreamp(sliderToDb(msg.v));
        break;
      case 'eqOn':
        ReampEq.setEnabled(msg.on);
        break;
      case 'play':
        player.play();
        break;
      case 'pause':
        lastWebCommandAt.current = Date.now();
        player.pause();
        break;
      case 'stop':
        lastWebCommandAt.current = Date.now();
        player.pause();
        player.seekTo(0).catch(() => {});
        break;
      case 'volume':
        player.volume = Math.max(0, Math.min(1, msg.v / 100));
        break;
      case 'seek':
        if (player.duration > 0) player.seekTo((player.duration * msg.percent) / 100).catch(() => {});
        break;
      case 'ready':
        // Re-enable the real visualizer if access was allowed before.
        getRecordingPermissionsAsync()
          .then(({ granted }) => granted && startRealVisualizer())
          .catch(() => {});
        break;
      case 'enableVis':
        askForRealVisualizer();
        break;
      case 'log':
        console.log('[player]', msg.msg);
        break;
    }
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar style="light" />
      <WebView
        ref={webRef}
        style={styles.web}
        source={{ uri: 'file:///android_asset/web/index.html' }}
        originWhitelist={['*']}
        allowFileAccess
        allowFileAccessFromFileURLs
        javaScriptEnabled
        scalesPageToFit
        setBuiltInZoomControls={false}
        overScrollMode="never"
        injectedJavaScriptBeforeContentLoaded={`window.__STATIONS = ${JSON.stringify(STATIONS)}; true;`}
        onMessage={onMessage}
        // Web links in the player (e.g. "Reamp..." in the long-press menu)
        // open in the phone's browser instead of replacing the player.
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req) => {
          if (/^https?:/i.test(req.url)) {
            Linking.openURL(req.url).catch(() => {});
            return false;
          }
          return true;
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  web: { flex: 1, backgroundColor: '#000' },
});
