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

  // --- Analyser for Webamp's visualizer, which only calls
  // getByteTimeDomainData() and runs its own FFT on 1024 samples.
  //
  // Real mode: Android sends the actual playing waveform (~10 times a second,
  // 1024 samples) once the user has allowed audio access. Between updates we
  // shrink the last waveform a little each frame so bars fall like Winamp's
  // instead of freezing.
  //
  // Fallback: until access is allowed, synthesise music-like audio (pink noise
  // with a kick on the beat and hats on the off-beat) so the bars and peaks
  // behave believably.
  function FakeAnalyser() {
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0;
    this.active = false;
    this.real = null;        // Float32Array of -1..1 from native
    this.realAt = 0;
    this._frame = 0;
    this._b = [0, 0, 0, 0, 0, 0, 0]; // pink noise filter state
    this._t0 = performance.now();
  }
  Object.defineProperty(FakeAnalyser.prototype, 'frequencyBinCount', {
    get: function () { return this.fftSize / 2; },
  });
  FakeAnalyser.prototype.setReal = function (bytes) {
    var out = new Float32Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = (bytes[i] - 128) / 128;
    this.real = out;
    this.realAt = performance.now();
  };
  FakeAnalyser.prototype._pink = function () {
    var b = this._b, w = Math.random() * 2 - 1;
    b[0] = 0.99886 * b[0] + w * 0.0555179; b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.969 * b[2] + w * 0.153852;    b[3] = 0.8665 * b[3] + w * 0.3104856;
    b[4] = 0.55 * b[4] + w * 0.5329522;    b[5] = -0.7616 * b[5] - w * 0.016898;
    var v = b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362;
    b[6] = w * 0.115926;
    return v * 0.11;
  };
  FakeAnalyser.prototype.getByteTimeDomainData = function (arr) {
    var n = arr.length, i;
    if (!this.active) { arr.fill(128); return; }
    var now = performance.now();
    var age = now - this.realAt;
    if (this.real && age < 400) {
      // ~0.85 per 16ms frame: fast attack (new data), smooth fall in between.
      var k = Math.pow(0.85, age / 16), src = this.real, m = src.length;
      for (i = 0; i < n; i++) {
        var v = src[Math.floor(i * m / n)] * k;
        arr[i] = Math.max(0, Math.min(255, 128 + v * 127));
      }
      return;
    }
    // Synthetic fallback at ~124 bpm.
    var t = (now - this._t0) / 1000, beat = 60 / 124;
    var ph = (t % beat) / beat;                 // 0..1 within the beat
    var kick = Math.exp(-ph * 9);               // thump at the start of each beat
    var hat = Math.exp(-Math.abs(ph - 0.5) * 30); // tick on the off-beat
    var swell = 0.6 + 0.3 * Math.sin(t * 0.37) + 0.15 * Math.sin(t * 1.9) + 0.1 * Math.random();
    var kf = 2 * Math.PI * (55 + 60 * kick) / 44100;
    var lp = this._lp || 0;
    for (i = 0; i < n; i++) {
      lp += 0.3 * (this._pink() - lp);        // soften the treble like real mixes
      var s = lp * swell * 1.4
        + Math.sin(i * kf + this._frame) * 0.5 * kick
        + (Math.random() * 2 - 1) * 0.06 * hat;
      arr[i] = Math.max(0, Math.min(255, 128 + s * 160));
    }
    this._lp = lp;
    this._frame += 1;
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

  var realVis = false;
  window.__fromNative = function (msg) {
    var m = window.__nativeMedia;
    if (!m) return;
    if (msg.t === 'status') m._onStatus(msg);
    else if (msg.t === 'samples') m._analyser.setReal(msg.d);
    else if (msg.t === 'visEnabled') realVis = true; // asked once; taps go back to Winamp
  };

  // First tap on the visualizer asks for real audio levels instead of
  // switching visualizer style. After that, taps behave like Winamp again.
  window.addEventListener('click', function (e) {
    if (realVis) return;
    if (e.target && e.target.id === 'visualizer') {
      e.stopPropagation();
      e.preventDefault();
      post({ t: 'enableVis' });
    }
  }, true);

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
