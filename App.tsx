import { useEffect, useRef } from 'react';
import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import {
  AudioStatus,
  createAudioPlayer,
  requestNotificationPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import { STATIONS } from './src/stations';

type WebMsg =
  | { t: 'ready' }
  | { t: 'log'; msg: string }
  | { t: 'load'; url: string; autoPlay: boolean; title: string }
  | { t: 'play' }
  | { t: 'pause' }
  | { t: 'stop' }
  | { t: 'volume'; v: number }
  | { t: 'seek'; percent: number };

// Webamp UI lives in the WebView; audio is played here, natively, so it keeps
// running in the background with lock-screen / notification controls.
const player = createAudioPlayer(null, { updateInterval: 500 });

export default function App() {
  const webRef = useRef<WebView>(null);
  const titleRef = useRef('Reamp Next');
  // Set when the web UI itself asked to pause/stop/load, so we can tell those
  // apart from pauses coming from the lock screen or headphones.
  const lastWebCommandAt = useRef(0);
  const wasPlaying = useRef(false);

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
      webRef.current?.injectJavaScript(
        `window.__fromNative && window.__fromNative(${JSON.stringify(payload)}); true;`,
      );
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
      case 'log':
        console.log('[webamp]', msg.msg);
        break;
    }
  };

  return (
    <View style={styles.container}>
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
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', paddingTop: 36 },
  web: { flex: 1, backgroundColor: '#000' },
});
