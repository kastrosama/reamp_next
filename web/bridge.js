/* Runs inside the WebView. Webamp draws the UI; all audio is played natively
 * (expo-audio) so it keeps going in the background and on the lock screen.
 *
 * Web -> native: window.ReactNativeWebView.postMessage(JSON)
 * Native -> web: window.__fromNative({ t: 'status', ... })
 */
(function () {
  var statusEl = document.getElementById('status');
  function setStatus(s) { statusEl.textContent = s || ''; }
  function post(msg) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
  }
  window.onerror = function (m) { setStatus('error: ' + m); post({ t: 'log', msg: String(m) }); };

  // --- Fake analyser: Webamp's visualizer only calls getByteTimeDomainData().
  // We don't capture real audio (that needs the microphone permission), so we
  // synthesise a lively waveform while playing and a flat line when stopped.
  function FakeAnalyser() {
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0;
    this.active = false;
    this._phase = 0;
  }
  Object.defineProperty(FakeAnalyser.prototype, 'frequencyBinCount', {
    get: function () { return this.fftSize / 2; },
  });
  FakeAnalyser.prototype.getByteTimeDomainData = function (arr) {
    if (!this.active) { arr.fill(128); return; }
    this._phase += 1;
    var p = this._phase;
    var a1 = 30 + 25 * Math.sin(p * 0.07), a2 = 18 + 14 * Math.sin(p * 0.13 + 1);
    var a3 = 10 + 9 * Math.sin(p * 0.31 + 2);
    for (var i = 0; i < arr.length; i++) {
      var v = a1 * Math.sin(i * 0.012 + p * 0.3) + a2 * Math.sin(i * 0.05 + p * 0.5) +
        a3 * Math.sin(i * 0.21 + p) + (Math.random() - 0.5) * 22;
      arr[i] = Math.max(0, Math.min(255, 128 + v));
    }
  };
  FakeAnalyser.prototype.getByteFrequencyData = function (arr) { arr.fill(0); };
  FakeAnalyser.prototype.getFloatTimeDomainData = function (arr) { arr.fill(0); };
  FakeAnalyser.prototype.connect = function () {};
  FakeAnalyser.prototype.disconnect = function () {};

  // --- IMedia implementation handed to Webamp via __customMediaClass.
  function NativeMedia() {
    this._listeners = {};
    this._time = 0;
    this._duration = 0;
    this._playing = false;
    this._buffering = false;
    this._analyser = new FakeAnalyser();
    window.__nativeMedia = this;
  }
  NativeMedia.prototype.on = function (ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); };
  NativeMedia.prototype._emit = function (ev) { (this._listeners[ev] || []).forEach(function (cb) { cb(); }); };
  NativeMedia.prototype.setVolume = function (v) { post({ t: 'volume', v: v }); };
  NativeMedia.prototype.setBalance = function () {};
  NativeMedia.prototype.setPreamp = function () {};
  NativeMedia.prototype.setEqBand = function () {};
  NativeMedia.prototype.disableEq = function () {};
  NativeMedia.prototype.enableEq = function () {};
  NativeMedia.prototype.timeElapsed = function () { return this._time; };
  NativeMedia.prototype.duration = function () { return this._duration; };
  NativeMedia.prototype.play = function () { post({ t: 'play' }); return Promise.resolve(); };
  NativeMedia.prototype.pause = function () { post({ t: 'pause' }); };
  NativeMedia.prototype.stop = function () { this._time = 0; post({ t: 'stop' }); };
  NativeMedia.prototype.seekToPercentComplete = function (pct) { post({ t: 'seek', percent: pct }); };
  NativeMedia.prototype.loadFromUrl = function (url, autoPlay) {
    this._time = 0;
    this._duration = 0;
    this._loadedSent = false;
    post({ t: 'load', url: url, autoPlay: !!autoPlay, title: titleFor(url) });
    return Promise.resolve();
  };
  NativeMedia.prototype.getAnalyser = function () { return this._analyser; };
  NativeMedia.prototype.dispose = function () {};

  // Status pushed from native every ~500ms and on every change.
  NativeMedia.prototype._onStatus = function (s) {
    this._time = s.currentTime || 0;
    this._duration = s.duration > 0 && isFinite(s.duration) ? s.duration : 0;
    if (s.isLoaded && !this._loadedSent) { this._loadedSent = true; this._emit('fileLoaded'); }
    if (s.isBuffering !== this._buffering) {
      this._buffering = s.isBuffering;
      this._emit(s.isBuffering ? 'waiting' : 'stopWaiting');
    }
    if (s.playing && !this._playing) this._emit('playing');
    this._playing = s.playing;
    this._analyser.active = s.playing;
    this._emit('timeupdate');
    if (s.didJustFinish) this._emit('ended');

    // Keep Webamp's buttons in sync when playback is changed from the lock
    // screen, headphones or notification.
    if (window.__webamp) {
      var ui = window.__webamp.getMediaStatus();
      if (s.playing && ui !== 'PLAYING') window.__webamp.play();
      if (!s.playing && ui === 'PLAYING' && s.externalPause) window.__webamp.pause();
    }
    setStatus(s.error ? 'stream error: ' + s.error : (s.isBuffering ? 'buffering…' : ''));
  };

  var stations = window.__STATIONS || [];
  function titleFor(url) {
    for (var i = 0; i < stations.length; i++) if (stations[i].url === url) return stations[i].name;
    return url;
  }

  window.__fromNative = function (msg) {
    if (msg.t === 'status' && window.__nativeMedia) window.__nativeMedia._onStatus(msg);
  };

  // --- Phone layout: main window, EQ and playlist stacked vertically,
  // playlist stretched to fill the rest of the screen.
  var H = window.innerHeight || 600;
  var extraHeight = Math.max(0, Math.floor((H - 116 * 3 - 8) / 29));

  var webamp = new Webamp({
    initialTracks: stations.map(function (s) {
      return { url: s.url, duration: 0, metaData: { artist: s.genre || 'Radio', title: s.name } };
    }),
    windowLayout: {
      main: { position: { top: 0, left: 0 } },
      equalizer: { position: { top: 116, left: 0 } },
      playlist: { position: { top: 232, left: 0 }, size: { extraHeight: extraHeight, extraWidth: 0 } },
    },
    enableHotkeys: false,
    handleAddUrlEvent: function () {
      var url = window.prompt('Stream URL');
      return url ? [{ url: url, duration: 0, metaData: { artist: 'Radio', title: url } }] : null;
    },
    __customMediaClass: NativeMedia,
  });
  window.__webamp = webamp;

  webamp.renderWhenReady(document.getElementById('app')).then(function () {
    setStatus('');
    post({ t: 'ready' });
  });
})();
