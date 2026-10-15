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
    var info = trackInfo(url);
    post({ t: 'load', url: url, autoPlay: !!autoPlay, title: info.title, artist: info.artist, live: info.live });
    currentUrl = url;
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
  var currentUrl = null;
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
      var bin = atob(f.b64), bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      refs.push(new File([bytes], f.name, { type: f.type || '' }));
    });
    resolve(refs);
  }

  var realVis = false;
  window.__fromNative = function (msg) {
    if (msg.t === 'picked') return onPicked(msg);
    var m = window.__nativeMedia;
    if (!m) return;
    if (msg.t === 'status') m._onStatus(msg);
    else if (msg.t === 'samples') m._analyser.setReal(msg.d);
    else if (msg.t === 'picked') onPicked(msg);
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

  // The engine (MIT, see THIRD_PARTY_NOTICES.md) exposes its constructor globally.
  var Engine = window.Webamp;
  var player = new Engine({
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
  function fitMenus() {
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
    requestAnimationFrame(fitMenus);
  }
  requestAnimationFrame(fitMenus);

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
    var target = document.elementFromPoint(p.clientX, p.clientY);
    if (target) {
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
    post({ t: 'ready' });
  });
})();
