/* Runs inside the WebView. the player engine draws the UI; all audio is played natively
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

  // --- Analyser for the player's visualizer, which only calls
  // getByteTimeDomainData() and runs its own FFT on 1024 samples.
  //
  // Instead of handing the player raw (noisy) audio every frame, we keep our own
  // set of smoothed band levels and synthesise a signal with exactly that
  // spectrum. That lets us control how the bars move: they rise at a moderate
  // pace and settle slowly, so the display follows the music without
  // flickering.
  //
  // Real mode: Android sends the playing waveform ~10x/s (1024 samples) once
  // the user allows audio access; we measure band levels from it.
  // Fallback: band levels from a relaxed half-tempo groove.
  // 24 log-spaced bands over FFT bins 1..511 (of a 1024-point frame).
  var NB = 24, N = 1024, EDGES = [], CENTER = [];
  for (var e = 0; e <= NB; e++) EDGES.push(Math.exp(Math.log(1) + (Math.log(512)) * e / NB));
  for (var c = 0; c < NB; c++) CENTER.push(Math.log(Math.sqrt(EDGES[c] * EDGES[c + 1])));
  var BINPHASE = new Float32Array(N / 2);
  for (var q = 0; q < N / 2; q++) BINPHASE[q] = Math.random() * Math.PI * 2;

  // In-place radix-2 complex FFT (inverse when inv is true, unscaled).
  function fft(re, im, inv) {
    var n = re.length, i, j, k, len;
    for (i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (len = 2; len <= n; len <<= 1) {
      var ang = 2 * Math.PI / len * (inv ? 1 : -1), wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cr = 1, ci = 0;
        for (k = 0; k < len / 2; k++) {
          var ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
          var ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
          re[i + k] += ar; im[i + k] += ai;
          var ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  function bandOf(k) {
    for (var b = 0; b < NB; b++) if (k < EDGES[b + 1]) return b;
    return NB - 1;
  }
  // The visualizer favours treble when every bin has equal energy, so
  // weight the synthesised bins to make equal levels look equal on screen.
  var TILT_EXP = window.__VIS_TILT || 0.6;
  var TILT = new Float32Array(N / 2);
  for (var tk = 1; tk < N / 2; tk++) TILT[tk] = Math.pow(tk / 16, -TILT_EXP);
  var BANDOF = new Int16Array(N / 2);
  for (var kk = 1; kk < N / 2; kk++) BANDOF[kk] = bandOf(kk);

  var RISE = 4;    // per second: how fast bars climb toward a new level
  var FALL = 1.6;  // per second: how fast they settle back down
  var GAIN = window.__VIS_GAIN || 90; // overall height

  function FakeAnalyser() {
    this.fftSize = 2048;
    this.smoothingTimeConstant = 0;
    this.active = false;
    this.cur = new Float32Array(NB);    // displayed levels 0..1
    this.target = new Float32Array(NB); // where they're heading
    this.realAt = 0;
    this.agc = 0.02;                    // running loudness for auto-gain
    this.lastT = performance.now();
    this.t0 = this.lastT;
    this.vary = new Float32Array(NB).fill(1);
    this.lastBeat = -1;
  }
  Object.defineProperty(FakeAnalyser.prototype, 'frequencyBinCount', {
    get: function () { return this.fftSize / 2; },
  });

  // Measure band levels from a real waveform (bytes 0..255, 128 = silence).
  FakeAnalyser.prototype.setReal = function (bytes) {
    var m = bytes.length, re = new Float32Array(N), im = new Float32Array(N), i, b;
    for (i = 0; i < N; i++) {
      var x = (bytes[Math.floor(i * m / N)] - 128) / 128;
      re[i] = x * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1))); // Hann window
    }
    fft(re, im, false);
    var e = new Float32Array(NB), cnt = new Float32Array(NB), sum = 0;
    for (i = 1; i < N / 2; i++) { b = BANDOF[i]; e[b] += Math.sqrt(re[i] * re[i] + im[i] * im[i]); cnt[b]++; }
    for (b = 0; b < NB; b++) { e[b] = cnt[b] ? e[b] / cnt[b] : 0; sum += e[b]; }
    // Auto-gain so quiet and loud stations both sit around halfway.
    this.agc = this.agc * 0.9 + Math.max(sum / NB, 1e-4) * 0.1;
    for (b = 0; b < NB; b++) {
      // Lift the treble a bit: real music's energy drops off steeply there.
      var tilt = 1 + 1.5 * b / (NB - 1);
      var lvl = Math.min(1, Math.sqrt(e[b] * tilt / (this.agc * 2.2)) * 0.8);
      // Blend with the previous reading so one noisy snapshot can't yank a bar.
      this.target[b] = this.target[b] * 0.45 + lvl * 0.55;
    }
    this.realAt = performance.now();
  };

  // Relaxed groove for the fallback: one pulse every ~1s (half of a typical
  // 120 bpm beat), bass leads, treble rolls off, and the shape drifts a
  // little on every pulse.
  FakeAnalyser.prototype._fakeTargets = function (now) {
    var t = (now - this.t0) / 1000, beat = 60 / 62;
    var n = Math.floor(t / beat), ph = (t % beat) / beat, b;
    if (n !== this.lastBeat) {
      this.lastBeat = n;
      for (b = 0; b < NB; b++) this.vary[b] = 0.75 + Math.random() * 0.5;
    }
    var pulse = Math.exp(-ph * 3.2);
    var swell = 0.85 + 0.15 * Math.sin(t * 0.3);
    for (b = 0; b < NB; b++) {
      var pos = b / (NB - 1);                     // 0 = bass, 1 = treble
      var shape = 0.58 - 0.18 * pos;              // treble sits a little lower
      var kick = (1 - pos) * (1 - pos) * 0.22 * pulse;
      this.target[b] = Math.min(1, (shape + kick) * this.vary[b] * swell);
    }
  };

  FakeAnalyser.prototype.getByteTimeDomainData = function (arr) {
    var n = arr.length, i, b;
    var now = performance.now();
    var dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;

    if (!this.active) this.target.fill(0);
    else if (now - this.realAt > 600) this._fakeTargets(now);

    var up = 1 - Math.exp(-RISE * dt), down = 1 - Math.exp(-FALL * dt);
    for (b = 0; b < NB; b++) {
      var d = this.target[b] - this.cur[b];
      this.cur[b] += d * (d > 0 ? up : down);
    }

    // Synthesise a signal whose spectrum follows these band levels
    // (smoothly interpolated across every FFT bin, so no bar is left empty).
    var re = this._re || (this._re = new Float32Array(N));
    var im = this._im || (this._im = new Float32Array(N));
    re.fill(0); im.fill(0);
    for (var k = 1; k < N / 2; k++) {
      var lk = Math.log(k), j = 0;
      while (j < NB - 2 && lk > CENTER[j + 1]) j++;
      var f = Math.max(0, Math.min(1, (lk - CENTER[j]) / (CENTER[j + 1] - CENTER[j])));
      var lvl = this.cur[j] * (1 - f) + this.cur[j + 1] * f;
      var a = Math.pow(lvl, 1.4) * GAIN * TILT[k];
      re[k] = a * Math.cos(BINPHASE[k]); im[k] = a * Math.sin(BINPHASE[k]);
      re[N - k] = re[k]; im[N - k] = -im[k];
    }
    fft(re, im, true);
    for (i = 0; i < n; i++) arr[i] = Math.max(0, Math.min(255, 128 + re[i & (N - 1)] / N * 127));
  };
  FakeAnalyser.prototype.getByteFrequencyData = function (arr) { arr.fill(0); };
  FakeAnalyser.prototype.getFloatTimeDomainData = function (arr) { arr.fill(0); };
  FakeAnalyser.prototype.connect = function () {};
  FakeAnalyser.prototype.disconnect = function () {};

  // --- Media implementation handed to the player engine (__customMediaClass).
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
  // EQ: slider values 0..100 (50 = 0 dB) are passed through; native maps them.
  var BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
  NativeMedia.prototype.setPreamp = function (v) { post({ t: 'eqPreamp', v: v }); };
  NativeMedia.prototype.setEqBand = function (band, v) {
    var i = BANDS.indexOf(Number(band));
    if (i >= 0) post({ t: 'eqBand', i: i, v: v });
  };
  NativeMedia.prototype.disableEq = function () { post({ t: 'eqOn', on: false }); };
  NativeMedia.prototype.enableEq = function () { post({ t: 'eqOn', on: true }); };
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
    this._sentDuration = 0;
    currentUrl = url;
    if (followingNative === url) {
      // The app already started this one itself (see 'advanced' below).
      followingNative = null;
    } else {
      var info = trackInfo(url), p = window.__player;
      var id = p && p.store ? p.store.getState().playlist.currentTrack : null;
      post({ t: 'load', url: url, autoPlay: !!autoPlay, title: info.title, artist: info.artist, live: info.live, id: id });
    }
    if (window.__autoEq) window.__autoEq();
    return Promise.resolve();
  };
  NativeMedia.prototype.getAnalyser = function () { return this._analyser; };
  NativeMedia.prototype.dispose = function () {};

  // Status pushed from native every ~500ms and on every change.
  NativeMedia.prototype._onStatus = function (s) {
    this._time = s.currentTime || 0;
    this._duration = s.duration > 0 && isFinite(s.duration) ? s.duration : 0;
    if (s.isLoaded && !this._loadedSent) { this._loadedSent = true; this._emit('fileLoaded'); }
    // Local files learn their length a moment after loading; tell the player
    // so the time display and seek bar work.
    if (this._duration > 0 && this._duration !== this._sentDuration) {
      this._sentDuration = this._duration;
      this._emit('fileLoaded');
    }
    if (s.isBuffering !== this._buffering) {
      this._buffering = s.isBuffering;
      this._emit(s.isBuffering ? 'waiting' : 'stopWaiting');
    }
    if (s.playing && !this._playing) this._emit('playing');
    this._playing = s.playing;
    this._analyser.active = s.playing;
    this._emit('timeupdate');
    if (s.didJustFinish) this._emit('ended');

    // Keep the player's buttons in sync when playback is changed from the lock
    // screen, headphones or notification.
    if (window.__player) {
      var ui = window.__player.getMediaStatus();
      if (s.playing && ui !== 'PLAYING') window.__player.play();
      if (!s.playing && ui === 'PLAYING' && s.externalPause) window.__player.pause();
    }
    setStatus(s.error ? 'stream error: ' + s.error : (s.isBuffering ? 'buffering…' : ''));
  };

  var stations = window.__STATIONS || [];
  // Bytes of the skin most recently handed to the player, and of the one
  // saved for next launch (so we know what to save when a skin finishes loading).
  var pendingSkin = window.__SAVED_SKIN || null, savedSkin = window.__SAVED_SKIN || null;
  var currentUrl = null;
  // Set while we catch up with a song the app moved on to by itself.
  var followingNative = null;
  function followNative(msg) {
    var p = window.__player;
    if (!p) return;
    followingNative = msg.url;
    p.store.dispatch({ type: 'PLAY_TRACK', id: msg.id });
    followingNative = null; // (consumed synchronously by loadFromUrl)
  }
  // Title/artist for the lock screen and notification. Stations come from
  // the station list; files from the playlist entry (tags or file name).
  function trackInfo(url) {
    var local = !/^https?:/i.test(url);
    for (var i = 0; i < stations.length; i++) {
      if (stations[i].url === url) return { title: stations[i].name, artist: stations[i].genre || 'Radio', live: true };
    }
    var p = window.__player;
    if (p && p.store) {
      var tracks = p.store.getState().tracks;
      for (var id in tracks) {
        var t = tracks[id];
        if (t.url === url) {
          var name = (t.defaultName || '').replace(/\.[a-z0-9]{2,4}$/i, '');
          return { title: t.title || name || url, artist: t.artist || (local ? '' : 'Radio'), live: !local };
        }
      }
    }
    return { title: url, artist: '', live: !local };
  }

  // --- Native file pickers. The engine's file dialogs call this (see
  // plugins/patchPlayer.js) and expect a list of picked file references.
  var pickId = 0, pickWaiting = {};
  window.__pickFiles = function (opts) {
    return new Promise(function (resolve) {
      var id = ++pickId;
      pickWaiting[id] = resolve;
      post({ t: 'pickFiles', id: id, accept: (opts && opts.accept) || null, directory: !!(opts && opts.directory) });
    });
  };
  function onPicked(msg) {
    var resolve = pickWaiting[msg.id];
    if (!resolve) return;
    delete pickWaiting[msg.id];
    var refs = [];
    // Music: references the native player can stream.
    (msg.items || []).forEach(function (it) { refs.push({ __url: it.url, name: it.name }); });
    // Small files the engine reads itself (EQ presets, skins): real File objects.
    (msg.files || []).forEach(function (f) {
      if (/\.(wsz|zip)$/i.test(f.name)) pendingSkin = f.b64;
      var bin = atob(f.b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      refs.push(new File([bytes], f.name, { type: f.type || '' }));
    });
    resolve(refs);
  }

  // Lengths and tags read natively for picked files: shown in the playlist
  // (and main display) before anything is played, like Winamp.
  function onMeta(items) {
    var p = window.__player;
    if (!p || !p.store) return;
    var tracks = p.store.getState().tracks, byUrl = {};
    for (var id in tracks) byUrl[tracks[id].url] = id;
    items.forEach(function (m) {
      var tid = byUrl[m.url];
      if (tid == null) return;
      if (m.duration > 0) p.store.dispatch({ type: 'SET_MEDIA_DURATION', id: Number(tid), duration: m.duration });
      if (m.title || m.artist) {
        p.store.dispatch({
          type: 'SET_MEDIA_TAGS', id: Number(tid),
          title: m.title || '', artist: m.artist || '', album: m.album || null, albumArtUrl: null,
          bitrate: m.bitrate || null, sampleRate: m.sampleRate || null, numberOfChannels: null,
        });
      }
    });
  }

  // --- Opened from another app: add to the end of the playlist and play
  // the first one (keeps whatever was already there).
  function openFiles(items) {
    var p = window.__player;
    if (!p || !items.length) return;
    var before = p.store.getState().playlist.trackOrder.length;
    p.appendTracks(items.map(function (it) {
      var t = { url: it.url, defaultName: it.name };
      // Radio entries from playlist files: name them, and don't try to
      // measure the length of an endless stream.
      if (it.live) { t.duration = 0; t.metaData = { artist: '', title: it.name }; }
      return t;
    }));
    var st = p.store.getState(), id = st.playlist.trackOrder[before];
    if (id != null) {
      p.store.dispatch({ type: 'CLICKED_TRACK', index: before });
      p.store.dispatch({ type: 'PLAY_TRACK', id: id });
    }
  }
  // A .wsz skin opened from another app.
  function openSkin(msg) {
    var p = window.__player;
    if (!p || !msg.b64) return;
    pendingSkin = msg.b64;
    var bin = atob(msg.b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    p.setSkinFromUrl(URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })));
  }

  var realVis = false;
  window.__fromNative = function (msg) {
    if (msg.t === 'picked') return onPicked(msg);
    if (msg.t === 'meta') return onMeta(msg.items || []);
    if (msg.t === 'openFiles') return openFiles(msg.items || []);
    if (msg.t === 'openSkin') return openSkin(msg);
    if (msg.t === 'advanced') return followNative(msg);
    var m = window.__nativeMedia;
    if (!m) return;
    if (msg.t === 'status') m._onStatus(msg);
    else if (msg.t === 'samples') m._analyser.setReal(msg.d);
    else if (msg.t === 'picked') onPicked(msg);
    else if (msg.t === 'meta') onMeta(msg.items || []);
    else if (msg.t === 'openFiles') openFiles(msg.items || []);
    else if (msg.t === 'openSkin') openSkin(msg);
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

  // --- Phone layout: main window, EQ and playlist stacked top to bottom at
  // full width. The playlist stretches to fill whatever height is left, and
  // re-stretches whenever the EQ or playlist is opened, closed or shaded.
  var FULL = 116, SHADE = 14, STEP = 29;
  var H = document.documentElement.clientHeight || window.innerHeight || 600;
  var extraHeight = Math.max(0, Math.floor((H - FULL * 3) / STEP));

  // --- What we start with: last session's playlist, windows and skin if
  // there is one (see src/savedState.ts), otherwise the starter stations.
  var SAVED = window.__SAVED || null;
  function b64ToBlobUrl(b64) {
    var bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  }
  var startTracks = SAVED && SAVED.tracks.length
    ? SAVED.tracks.map(function (t) {
        var tr = { url: t.url, defaultName: t.name || t.url };
        if (t.duration != null) tr.duration = t.duration;
        if (t.live || t.title || t.artist) tr.metaData = { artist: t.artist || '', title: t.title || '', album: t.album || null };
        if (t.live && tr.duration == null) tr.duration = 0;
        return tr;
      })
    : stations.map(function (s) {
        return { url: s.url, duration: 0, metaData: { artist: s.genre || 'Radio', title: s.name } };
      });
  var w0 = (SAVED && SAVED.windows) || {};
  function winOpts(id) {
    var w = w0[id] || {};
    return { closed: w.open === false, shadeMode: !!w.shade };
  }

  // The engine (MIT, see THIRD_PARTY_NOTICES.md) exposes its constructor globally.
  var Engine = window.Webamp;
  var player = new Engine({
    initialTracks: startTracks,
    initialSkin: window.__SAVED_SKIN ? { url: b64ToBlobUrl(window.__SAVED_SKIN) } : undefined,
    windowLayout: {
      // The main window always starts open (closing it would leave no controls).
      main: Object.assign({ position: { top: 0, left: 0 } }, winOpts('main'), { closed: false }),
      equalizer: Object.assign({ position: { top: 116, left: 0 } }, winOpts('equalizer')),
      playlist: Object.assign({ position: { top: 232, left: 0 }, size: { extraHeight: extraHeight, extraWidth: 0 } }, winOpts('playlist')),
    },
    enableHotkeys: false,
    handleAddUrlEvent: function () {
      var url = window.prompt('Stream URL');
      return url ? [{ url: url, duration: 0, metaData: { artist: 'Radio', title: url } }] : null;
    },
    __customMediaClass: NativeMedia,
  });
  window.__player = player;

  function layout() {
    var store = player.store, st = store.getState(), w = st.windows.genWindows;
    // Layout viewport height: stays the same while pinch-zoomed.
    var H = document.documentElement.clientHeight;
    var main = w.main, eq = w.equalizer, pl = w.playlist;
    var hMain = main.open ? (main.shade ? SHADE : FULL) : 0;
    var hEq = eq.open ? (eq.shade ? SHADE : FULL) : 0;
    var plExtra = pl.size ? pl.size[1] : 0;
    var hPl = 0;
    if (pl.open) {
      if (pl.shade) hPl = SHADE;
      else {
        plExtra = Math.max(0, Math.floor((H - hMain - hEq - FULL) / STEP));
        hPl = FULL + plExtra * STEP;
      }
    }
    // Centre the stack vertically so any leftover (< one playlist step)
    // is split thinly above and below.
    var top = Math.max(0, Math.floor((H - hMain - hEq - hPl) / 2));
    var want = {
      main: { x: 0, y: top },
      equalizer: { x: 0, y: top + hMain },
      playlist: { x: 0, y: top + hMain + hEq },
    };
    var moved = ['main', 'equalizer', 'playlist'].some(function (id) {
      var p = w[id].position;
      return !p || p.x !== want[id].x || p.y !== want[id].y;
    });
    if (pl.open && !pl.shade && (!pl.size || pl.size[0] !== 0 || pl.size[1] !== plExtra)) {
      store.dispatch({ type: 'WINDOW_SIZE_CHANGED', windowId: 'playlist', size: [0, plExtra] });
    }
    if (moved) store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions: want, absolute: true });
  }

  // --- EQ "Auto": pick a preset from the station's genre whenever the
  // station changes (or Auto is switched on). Winamp's built-in presets,
  // values are [preamp, 60, 170, 310, 600, 1k, 3k, 6k, 12k, 14k, 16k] on
  // Winamp's 1..64 scale.
  var PRESETS = {"Classical": [33, 33, 33, 33, 33, 33, 33, 20, 20, 20, 16], "Club": [33, 33, 33, 38, 42, 42, 42, 38, 33, 33, 33], "Dance": [33, 48, 44, 36, 32, 32, 22, 20, 20, 32, 32], "Laptop speakers/headphones": [33, 40, 50, 41, 26, 28, 35, 40, 48, 53, 56], "Large hall": [33, 49, 49, 42, 42, 33, 24, 24, 24, 33, 33], "Party": [33, 44, 44, 33, 33, 33, 33, 33, 33, 44, 44], "Pop": [33, 29, 40, 44, 45, 41, 30, 28, 28, 29, 29], "Reggae": [33, 33, 33, 31, 22, 33, 43, 43, 33, 33, 33], "Rock": [33, 45, 40, 23, 19, 26, 39, 47, 50, 50, 50], "Soft": [33, 40, 35, 30, 28, 30, 39, 46, 48, 50, 52], "Ska": [33, 28, 24, 25, 31, 39, 42, 47, 48, 50, 48], "Full Bass": [33, 48, 48, 48, 42, 35, 25, 18, 15, 14, 14], "Soft Rock": [33, 39, 39, 36, 31, 25, 23, 26, 31, 37, 47], "Full Treble": [33, 16, 16, 16, 25, 37, 50, 58, 58, 58, 60], "Full Bass & Treble": [33, 44, 42, 33, 20, 24, 35, 46, 50, 52, 52], "Live": [33, 24, 33, 39, 41, 42, 42, 39, 37, 37, 36], "Techno": [33, 45, 42, 33, 23, 24, 33, 45, 48, 48, 47]};
  var GENRE_PRESETS = [
    [/techno|house|trance|edm|electro|drum|dnb|d&b|dubstep|breaks|garage/, 'Techno'],
    [/dance|club|disco/, 'Dance'],
    [/hip ?hop|hip-hop|rap|r&b|rnb|urban|trap|bass/, 'Full Bass'],
    [/metal|punk|grunge|hard rock/, 'Rock'],
    [/soft rock|classic rock|oldies/, 'Soft Rock'],
    [/rock|alternative/, 'Rock'],
    [/indie|pop|top ?40|hits|chart/, 'Pop'],
    [/ska/, 'Ska'],
    [/reggae|dub|dancehall/, 'Reggae'],
    [/classical|orchestra|opera|baroque|symphon/, 'Classical'],
    [/ambient|drone|space|new age|meditation|sleep/, 'Large hall'],
    [/jazz|lounge|soul|blues|acoustic|folk|easy|chill|downtempo|lo-?fi/, 'Soft'],
    [/live|concert/, 'Live'],
    [/party/, 'Party'],
  ];
  var BAND_KEYS = ['preamp'].concat(BANDS);

  function genreFor(url) {
    for (var i = 0; i < stations.length; i++) {
      if (stations[i].url === url) return (stations[i].genre || '') + ' ' + stations[i].name;
    }
    return '';
  }
  function presetForGenre(text) {
    var g = (text || '').toLowerCase();
    // Talk/news stations and anything unrecognised get a flat EQ.
    if (/talk|news|sport|speech|podcast/.test(g)) return null;
    for (var i = 0; i < GENRE_PRESETS.length; i++) {
      if (GENRE_PRESETS[i][0].test(g)) return GENRE_PRESETS[i][1];
    }
    return null;
  }
  var statusTimer = null;
  function flash(msg) {
    setStatus(msg);
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { setStatus(''); }, 2500);
  }
  window.__autoEq = function () {
    if (!player || !player.store) return;
    var st = player.store.getState();
    if (!st.equalizer.auto || !currentUrl) return;
    var name = presetForGenre(genreFor(currentUrl));
    var vals = name ? PRESETS[name] : null;
    BAND_KEYS.forEach(function (key, i) {
      // Winamp 1..64 -> slider 0..100; flat = 50.
      var v = vals ? Math.round(((vals[i] - 1) / 63) * 100) : 50;
      player.store.dispatch({ type: 'SET_BAND_VALUE', band: key, value: v });
    });
    flash('Auto EQ: ' + (name || 'Flat'));
  };

  // --- Remember the playlist, the last-played track and the windows for next
  // launch, and the skin (the last one loaded becomes the default).
  var defaultSkinImages = player.store.getState().display.skinImages;
  function snapshotState() {
    var st = player.store.getState(), tracks = st.tracks, order = st.playlist.trackOrder;
    var w = st.windows.genWindows;
    var win = function (id) { return { open: !!w[id].open, shade: !!w[id].shade }; };
    return {
      version: 1,
      tracks: order.map(function (id) {
        var t = tracks[id];
        return {
          url: t.url, name: t.defaultName || undefined, title: t.title || undefined,
          artist: t.artist || undefined, album: t.album || undefined,
          duration: t.duration == null ? null : t.duration,
          live: /^https?:/i.test(t.url) && !t.duration,
        };
      }),
      current: order.indexOf(st.playlist.currentTrack),
      windows: { main: win('main'), equalizer: win('equalizer'), playlist: win('playlist') },
    };
  }
  function startRemembering() {
    // Put the last-played track back in place, loaded but not playing.
    if (SAVED && SAVED.current >= 0) {
      var id = player.store.getState().playlist.trackOrder[SAVED.current];
      if (id != null) player.store.dispatch({ type: 'BUFFER_TRACK', id: id });
    }
    var lastJson = '', timer = null, lastSkinImages = player.store.getState().display.skinImages;
    player.store.subscribe(function () {
      var st = player.store.getState();
      // Skin: saved once it has actually loaded; back to the base skin clears it.
      if (st.display.skinImages !== lastSkinImages) {
        lastSkinImages = st.display.skinImages;
        if (lastSkinImages === defaultSkinImages) {
          if (savedSkin) { savedSkin = null; pendingSkin = null; post({ t: 'saveSkin', b64: null }); }
        } else if (pendingSkin && pendingSkin !== savedSkin) {
          savedSkin = pendingSkin;
          post({ t: 'saveSkin', b64: savedSkin });
        }
      }
      // The state changes constantly (scrolling title, time), so check at most
      // once a second and only save when something we remember changed.
      if (timer) return;
      timer = setTimeout(function () {
        timer = null;
        var snap = snapshotState(), json = JSON.stringify(snap);
        if (json !== lastJson) { lastJson = json; post({ t: 'saveState', state: snap }); }
      }, 1000);
    });
  }

  // --- Keep the app's copy of the playlist up to date (it starts the next
  // song itself the moment one ends; see src/queue.ts).
  function queueSnapshot() {
    var st = player.store.getState(), tracks = st.tracks;
    return {
      t: 'queue',
      items: st.playlist.trackOrder.filter(function (id) { return tracks[id] && tracks[id].url; }).map(function (id) {
        var info = trackInfo(tracks[id].url);
        return { id: Number(id), url: tracks[id].url, title: String(info.title), artist: info.artist || '', live: !!info.live };
      }),
      current: st.playlist.currentTrack == null ? null : Number(st.playlist.currentTrack),
      shuffle: !!st.media.shuffle,
      repeat: !!st.media.repeat,
    };
  }
  function startQueueSync() {
    var last = {}, timer = null;
    function changed(st) {
      var now = { order: st.playlist.trackOrder, tracks: st.tracks, cur: st.playlist.currentTrack,
        sh: st.media.shuffle, rep: st.media.repeat };
      var diff = Object.keys(now).some(function (k) { return now[k] !== last[k]; });
      var urgent = now.cur !== last.cur || now.sh !== last.sh || now.rep !== last.rep;
      last = now;
      return diff ? (urgent ? 2 : 1) : 0;
    }
    function send() { timer = null; post(queueSnapshot()); }
    player.store.subscribe(function () {
      var c = changed(player.store.getState());
      if (!c) return;
      // Track switches and shuffle/repeat go straight away; tags and lengths
      // filling in (lots of small changes) are batched.
      if (c === 2) { clearTimeout(timer); send(); }
      else if (!timer) timer = setTimeout(send, 400);
    });
    changed(player.store.getState());
    send();
  }

  // --- Keep the playing song in view: centred in the playlist whenever the
  // track changes, unless the playlist was touched in the last 10 seconds.
  var lastPlaylistTouch = 0;
  window.addEventListener('touchstart', function (e) {
    if (e.target && e.target.closest && e.target.closest('#playlist-window')) lastPlaylistTouch = Date.now();
  }, { capture: true, passive: true });
  function startFollowingCurrent() {
    // A track change is remembered until it can be shown: if the playlist
    // was touched recently (or the app was in the background), it's done as
    // soon as the playlist has been left alone for 10 seconds.
    var lastCur = player.store.getState().playlist.currentTrack, pending = lastCur != null;
    function tryCentre() {
      if (!pending || document.hidden) return;
      if (Date.now() - lastPlaylistTouch < 10000 || pg || momentum) return;
      pending = false;
      var st = player.store.getState(), index = st.playlist.trackOrder.indexOf(st.playlist.currentTrack);
      if (index < 0) return;
      setScrollOffset(index - Math.floor((visibleRows() - 1) / 2));
    }
    player.store.subscribe(function () {
      var cur = player.store.getState().playlist.currentTrack;
      if (cur === lastCur) return;
      lastCur = cur;
      pending = true;
      tryCentre();
    });
    setInterval(tryCentre, 1000);
    document.addEventListener('visibilitychange', tryCentre);
  }

  // Send the current EQ settings to native (the player only pushes changes).
  function syncEq() {
    var eq = player.store.getState().equalizer;
    post({ t: 'eqOn', on: !!eq.on });
    post({ t: 'eqPreamp', v: eq.sliders.preamp });
    BANDS.forEach(function (b, i) { post({ t: 'eqBand', i: i, v: eq.sliders[b] }); });
  }

  // Keep every player menu (presets, options, playlist buttons) and its
  // sub-menus fully on screen. Sub-menus open on hover/tap via CSS, so we
  // check every frame while a menu is open and nudge anything that pokes
  // out back inside the window.
  function fitMenusOnce() {
    // The engine creates a separate container for every menu, all with the
    // same (engine-defined) id, so select them all rather than using getElementById.
    var menus = document.querySelectorAll('[id="webamp-context-menu"] ul, ul.context-menu');
    if (menus.length) {
      var W = document.documentElement.clientWidth, H = document.documentElement.clientHeight, M = 1;
      for (var i = 0; i < menus.length; i++) {
        var ul = menus[i];
        if (!ul.getClientRects().length) continue; // hidden sub-menu
        ul.style.transform = '';
        var r = ul.getBoundingClientRect();
        var dx = 0, dy = 0;
        if (r.right > W - M) dx = W - M - r.right;
        if (r.left + dx < M) dx = M - r.left;
        if (r.bottom > H - M) dy = H - M - r.bottom;
        if (r.top + dy < M) dy = M - r.top;
        if (dx || dy) ul.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      }
    }
  }
  function fitMenus() {
    fitMenusOnce();
    requestAnimationFrame(fitMenus);
  }
  requestAnimationFrame(fitMenus);
  // Also fit a menu the instant it's added, before it's ever painted.
  new MutationObserver(fitMenusOnce).observe(document.body, { childList: true, subtree: true });

  // --- Pinch-to-zoom: handled by the WebView itself (nothing is drawn or
  // changed in the player). Double-tap while zoomed snaps back to normal.
  // When not zoomed, double-tap does what it always did (e.g. shade a window).
  var vp = document.getElementById('vp');
  var VP_ZOOM = vp.getAttribute('content');
  function isZoomed() {
    // Zoomed in = we can see noticeably less than the full page width.
    var v = window.visualViewport;
    return v ? v.width < document.documentElement.clientWidth * 0.95 : false;
  }
  function resetZoom() {
    // Briefly disallowing zoom makes the browser snap back to fit-width.
    vp.setAttribute('content', 'width=275, user-scalable=no');
    setTimeout(function () { vp.setAttribute('content', VP_ZOOM); }, 350);
  }
  var lastTap = { t: 0, x: 0, y: 0 }, ownDbl = 0;
  document.addEventListener('touchend', function (e) {
    if (e.touches.length || e.changedTouches.length !== 1) return;
    var p = e.changedTouches[0], now = Date.now();
    var dbl = now - lastTap.t < 350 && Math.abs(p.clientX - lastTap.x) < 25 && Math.abs(p.clientY - lastTap.y) < 25;
    lastTap = { t: dbl ? 0 : now, x: p.clientX, y: p.clientY };
    if (!dbl) return;
    ownDbl = now;
    if (isZoomed()) {
      e.preventDefault();
      resetZoom();
      return;
    }
    // Not zoomed: deliver the double-tap to the player as a double-click
    // (e.g. shade a window by double-tapping its title bar, like Winamp).
    // The playlist's track list handles its own taps (see below).
    var target = document.elementFromPoint(p.clientX, p.clientY);
    if (target && !target.closest('.playlist-tracks')) {
      target.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, view: window, clientX: p.clientX, clientY: p.clientY,
        __reamp: true,
      }));
    }
  }, { capture: true, passive: false });
  // Ignore any double-click the browser itself generates from those taps, so
  // nothing happens twice.
  document.addEventListener('dblclick', function (e) {
    if (e.isTrusted && Date.now() - ownDbl < 600) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  // --- Two-finger gestures belong to zoom only. The first finger may already
  // have started something (dragging a window, a slider, a track); as soon
  // as a second finger lands we end it, put back anything it changed, and
  // keep the player from seeing the rest of the gesture.
  var multi = false, multiEndedAt = 0, firstTouch = null;
  function snapshot() {
    var p = window.__player;
    if (!p || !p.store) return null;
    var st = p.store.getState();
    return { at: Date.now(), volume: st.media.volume, balance: st.media.balance,
      sliders: Object.assign({}, st.equalizer.sliders), selected: st.playlist.selectedTracks.slice() };
  }
  function restore(snap) {
    var p = window.__player;
    if (!snap || !p) return;
    var st = p.store.getState();
    if (st.media.volume !== snap.volume) p.store.dispatch({ type: 'SET_VOLUME', volume: snap.volume });
    if (st.media.balance !== snap.balance) p.store.dispatch({ type: 'SET_BALANCE', balance: snap.balance });
    Object.keys(snap.sliders).forEach(function (k) {
      if (st.equalizer.sliders[k] !== snap.sliders[k]) {
        p.store.dispatch({ type: 'SET_BAND_VALUE', band: k === 'preamp' ? 'preamp' : Number(k), value: snap.sliders[k] });
      }
    });
  }
  function endEngineDrags() {
    // The engine ends drags on these; synthetic copies stop anything in progress.
    window.dispatchEvent(new Event('touchend'));
    window.dispatchEvent(new MouseEvent('mouseup'));
    document.dispatchEvent(new PointerEvent('pointerup'));
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  window.addEventListener('touchstart', function (e) {
    if (!e.touches) return;
    if (e.touches.length === 1 && !multi) { firstTouch = snapshot(); return; }
    if (e.touches.length >= 2) {
      if (!multi) {
        multi = true;
        cancelPlaylistGesture();
        endEngineDrags();
        if (firstTouch && Date.now() - firstTouch.at < 1500) restore(firstTouch);
      }
      e.stopImmediatePropagation();
    }
  }, { capture: true, passive: true });
  ['touchmove', 'touchend', 'touchcancel', 'pointermove', 'pointerup', 'pointerdown', 'mousedown', 'mouseup', 'click', 'contextmenu'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (multi || Date.now() - multiEndedAt < 400) {
        e.stopImmediatePropagation();
        if (type === 'click' || type === 'contextmenu') e.preventDefault();
      }
      if ((type === 'touchend' || type === 'touchcancel') && multi && e.isTrusted && e.touches && e.touches.length === 0) {
        multi = false;
        multiEndedAt = Date.now();
      }
    }, { capture: true, passive: false });
  });

  // --- Playlist touch, phone style (instead of the desktop mouse behaviour):
  //   swipe          scroll (row by row, like Winamp), with a little momentum
  //   tap            select a track
  //   double-tap     play it
  //   hold + drag    move the selected track(s) up or down
  //   hold + release open the long-press menu
  var TRACK_H = 13, HOLD_MS = 450, MOVE_PX = 6;
  var pg = null, momentum = null, lastTrackTap = { t: 0, index: -1 };

  function plState() { return window.__player.store.getState(); }
  function visibleRows() {
    var size = plState().windows.genWindows.playlist.size || [0, 0];
    return Math.floor((58 + 29 * size[1]) / TRACK_H);
  }
  function scrollOffset() {
    var st = plState(), overflow = Math.max(0, st.playlist.trackOrder.length - visibleRows());
    return overflow ? Math.round((st.display.playlistScrollPosition / 100) * overflow) : 0;
  }
  function setScrollOffset(off) {
    var st = plState(), overflow = Math.max(0, st.playlist.trackOrder.length - visibleRows());
    if (!overflow) return false;
    var clamped = Math.max(0, Math.min(overflow, off));
    window.__player.store.dispatch({ type: 'SET_PLAYLIST_SCROLL_POSITION', position: (clamped / overflow) * 100 });
    return clamped === off;
  }
  function rowAt(clientY) {
    var box = document.querySelector('#playlist-window .playlist-tracks');
    if (!box) return -1;
    var r = box.getBoundingClientRect();
    return Math.floor((clientY - r.top) / TRACK_H) + scrollOffset();
  }
  function selectRow(index) {
    var st = plState();
    if (index >= 0 && index < st.playlist.trackOrder.length) {
      window.__player.store.dispatch({ type: 'CLICKED_TRACK', index: index });
      return st.playlist.trackOrder[index];
    }
    window.__player.store.dispatch({ type: 'SELECT_ZERO' });
    return null;
  }
  function moveSelected(rows) {
    var st = plState(), order = st.playlist.trackOrder, sel = st.playlist.selectedTracks;
    var first = -1, last = -1;
    order.forEach(function (id, i) { if (sel.indexOf(id) !== -1) { if (first < 0) first = i; last = i; } });
    if (first < 0) return 0;
    var off = Math.max(-first, Math.min(order.length - 1 - last, rows));
    if (off) window.__player.store.dispatch({ type: 'DRAG_SELECTED', offset: off });
    return off;
  }
  function cancelPlaylistGesture() {
    if (pg && pg.timer) clearTimeout(pg.timer);
    pg = null;
  }
  function stopMomentum() { if (momentum) { cancelAnimationFrame(momentum); momentum = null; } }

  window.addEventListener('touchstart', function (e) {
    if (multi || !e.touches || e.touches.length !== 1) return;
    var cell = e.target.closest && e.target.closest('#playlist-window .playlist-tracks');
    if (!cell) return;
    e.stopImmediatePropagation(); // keep the engine's drag-to-reorder out of it
    stopMomentum();
    var t = e.touches[0];
    pg = { x0: t.clientX, y0: t.clientY, y: t.clientY, t0: Date.now(), mode: 'pending',
      row: rowAt(t.clientY), startOffset: scrollOffset(), moved: 0, samples: [[Date.now(), t.clientY]] };
    pg.timer = setTimeout(function () {
      if (!pg || pg.mode !== 'pending') return;
      pg.mode = 'held';
      var st = plState(), id = st.playlist.trackOrder[pg.row];
      if (id != null && st.playlist.selectedTracks.indexOf(id) === -1) selectRow(pg.row);
    }, HOLD_MS);
  }, { capture: true, passive: true });

  window.addEventListener('touchmove', function (e) {
    if (!pg || multi) return;
    e.stopImmediatePropagation();
    var t = e.touches[0], dy = t.clientY - pg.y0;
    pg.y = t.clientY;
    pg.samples.push([Date.now(), t.clientY]);
    if (pg.samples.length > 6) pg.samples.shift();
    if (pg.mode === 'pending' && (Math.abs(dy) > MOVE_PX || Math.abs(t.clientX - pg.x0) > MOVE_PX)) {
      clearTimeout(pg.timer);
      pg.mode = 'scroll';
    } else if (pg.mode === 'held' && Math.abs(dy) > MOVE_PX) {
      pg.mode = 'reorder';
    }
    if (pg.mode === 'scroll') {
      setScrollOffset(pg.startOffset - Math.round(dy / TRACK_H));
    } else if (pg.mode === 'reorder') {
      var want = Math.round(dy / TRACK_H);
      if (want !== pg.moved) pg.moved += moveSelected(want - pg.moved);
    }
  }, { capture: true, passive: true });

  window.addEventListener('touchend', function (e) {
    if (!pg || !e.isTrusted) return;
    var g = pg;
    cancelPlaylistGesture();
    if (multi) return;
    e.stopImmediatePropagation();
    e.preventDefault(); // no emulated mouse clicks afterwards
    if (g.mode === 'pending') {
      // Tap / double-tap.
      var now = Date.now();
      var dbl = now - lastTrackTap.t < 350 && lastTrackTap.index === g.row;
      lastTrackTap = { t: dbl ? 0 : now, index: g.row };
      var id = selectRow(g.row);
      if (dbl && id != null && !isZoomed()) window.__player.store.dispatch({ type: 'PLAY_TRACK', id: id });
    } else if (g.mode === 'held') {
      // Held without moving: the long-press menu, at the finger.
      var el = document.elementFromPoint(g.x0, g.y0);
      if (el) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: g.x0, clientY: g.y0, view: window }));
    } else if (g.mode === 'scroll') {
      // Momentum: keep going at the release speed, slowing down.
      var a = g.samples[0], b = g.samples[g.samples.length - 1];
      var v = (b[1] - a[1]) / Math.max(1, b[0] - a[0]); // px per ms
      if (Math.abs(v) > 0.25) {
        var pos = scrollOffset() * TRACK_H, last = performance.now();
        var step = function (ts) {
          var dt = ts - last; last = ts;
          pos -= v * dt;
          v *= Math.pow(0.996, dt);
          var inRange = setScrollOffset(Math.round(pos / TRACK_H));
          momentum = (inRange && Math.abs(v) > 0.03) ? requestAnimationFrame(step) : null;
        };
        momentum = requestAnimationFrame(step);
      }
    }
  }, { capture: true, passive: false });

  // Android sometimes cancels a touch instead of ending it; drop the gesture
  // so nothing is left thinking a finger is still down.
  window.addEventListener('touchcancel', function () { cancelPlaylistGesture(); }, true);

  // Android's own long-press would open the menu while the finger is still
  // down (and before we know whether it's a drag). Over the track list we
  // open it ourselves on release instead.
  window.addEventListener('contextmenu', function (e) {
    if (e.isTrusted && e.target.closest && e.target.closest('#playlist-window .playlist-tracks')) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  player.renderWhenReady(document.getElementById('app')).then(function () {
    setStatus('');
    var busy = false;
    var wasAuto = player.store.getState().equalizer.auto;
    player.store.subscribe(function () {
      var auto = player.store.getState().equalizer.auto;
      if (auto && !wasAuto) { wasAuto = auto; window.__autoEq(); }
      wasAuto = auto;
      if (busy) return;
      busy = true;
      try { layout(); } finally { busy = false; }
    });
    window.addEventListener('resize', layout);
    layout();
    syncEq();
    startRemembering();
    startQueueSync();
    startFollowingCurrent();
    post({ t: 'ready' });
  });
})();
