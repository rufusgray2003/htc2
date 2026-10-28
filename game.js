'use strict';
/*
 * Hit The Cyclist 2
 * Phase 1 (hitter): first-person at the top of a cliff. A cyclist rides toward the edge;
 *   whack them forward, the way they're already going, and off the cliff.
 * Phase 2 (rider): the rider is knocked off the bike and bounces along the dirt plain
 *   on their belly. First-person from their head, with a follow cam inset.
 * Forward is -Z. The cliff edge is at z = 0; the plain below is at y = 0.
 */
(() => {
  // ------------------------------------------------------------------
  // Constants / tuning
  // ------------------------------------------------------------------
  const CLIFF_H = 50;          // cliff height (m)
  const CHUNK = 50;            // plain chunk length (m)
  const GEN_AHEAD = 450;
  const KEEP_BEHIND = 90;
  const GRAVITY = 9.8;
  const AIR_DRAG = 0.0014;     // per (m/s)^2
  const SLIDE_FRICTION = 4.1;  // belly sliding on dirt, m/s^2
  const SLIDE_DRAG = 0.0068;   // extra sliding drag per (m/s)^2
  const RESTITUTION = 0.39;    // belly bounce
  const SWEET_Z = 9;           // midpoint between the two grass patches: the perfect hit
  const HIT_WINDOW = 2.2;      // +/- metres: the outer edges of the two grass patches
  const PATCH_GAP = 0.8;       // dirt gap either side of the midpoint, between the patches
  const HITTER_POS = new THREE.Vector3(4.2, CLIFF_H, SWEET_Z + 0.6);
  // Timing sets the launch: t = +1 (as early as possible) .. -1 (as late as possible)
  const ANGLE_MID = 22, ANGLE_SPAN = 30; // launch angle = 22 + 30 * t degrees
  const LATE_SPEED = 0.25;     // late hits are up to 25% faster, early ones 25% slower
  const PERFECT_T = 0.2;       // |t| below this = perfect
  const DENSITY_FLOOR_AT = 1000; // obstacles thin out to 50% by this distance
  const EGG_GAP_MIN = 500, EGG_GAP_MAX = 1000; // metres between easter eggs
  const LANE_X = 0.8;
  const PLAY_X = 13;           // how far sideways the rider can drift
  const STEER_SPEED = 9;       // minimum sideways speed (m/s); grows with forward speed
  // Splut = height + angle. Like the original, how fast you're falling (i.e. how far you've dropped) is the
  // main thing; unlike it, a steep landing makes it worse and a shallow one forgives a bit.
  // danger = falling speed * (0.6 for a flat landing .. 1.4 straight down); splut above SPLUT_LIMIT.
  const SPLUT_LIMIT = 37;
  const SPLUT_FLAT = 0.6, SPLUT_STEEP = 0.8;
  const RIDER_SPEED_MIN = 11, RIDER_SPEED_MAX = 14; // cyclist's base speed (m/s), ~40-50 km/h
  const RIDER_SURGE = 0.07;     // pedalling surges: speed drifts up to +/-7% during the approach
  const SPLUT_TIME = 1.4;       // seconds stuck head-first before the results
  const MOLE_T = 1.8;           // splut into a molehill: seconds the mole whiffles at you
  const RUNUP_Z = 45;           // where the cyclist starts (m from the edge)
  const MAX_SLOTS = 3;
  const ROCKET_TIME = 1.2;      // seconds of rocket thrust
  const WINGSUIT_TIME = 20;     // seconds of wingsuit glide (ends when you touch the ground)
  const WINGSUIT_CHANCE = 1 / 6; // chance per 50 m of a wingsuit hidden in a low cloud (~1 per 300 m)
  const EGG_EFFECT_TIME = 30;   // seconds that easter-egg effects last
  const FLIP_RANGE = 3;         // the rude mole only appears if you stop this close to its molehill
  // Height haze: the higher you are, the more the ground below fades into the sky
  const HAZE_START = 40;        // fully clear below this height (m)
  const HAZE_FULL = 65;         // completely faded out above this height (m)
  const FOG_NEAR = 160, FOG_FAR = 450; // normal fog
  const HAZE_AHEAD = 2.2, HAZE_BEHIND = 0.7, HAZE_SIDE = 0.9; // shape of the clear oval around you
  const ROCK_SPLAT_SPEED = 7;   // hit a rock slower than this (m/s) and you just stop, no splat
  const LAYER_RIDER = 1;       // prone rider: hidden from the first-person camera
  const LAYER_FP = 2;          // first-person bat/arms: main camera only
  const LAYER_HITTER = 3;      // hitter's body: follow cam only

  const $ = (id) => document.getElementById(id);
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = THREE.MathUtils.clamp;
  const lerp = THREE.MathUtils.lerp;
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const groundAt = (z) => (z > 0 ? CLIFF_H : 0);
  const setLayer = (obj, n) => obj.traverse((o) => o.layers.set(n));

  // ------------------------------------------------------------------
  // Renderer / scene / cameras
  // ------------------------------------------------------------------
  // Phones and tablets: tap controls, landscape only. Add ?touch to the URL to force it on a desktop.
  const TOUCH = matchMedia('(pointer: coarse)').matches || /[?&]touch\b/.test(location.search);
  if (TOUCH) document.body.classList.add('touch');
  const isPortrait = () => TOUCH && innerHeight > innerWidth;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, TOUCH ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false; // updated once per frame, not per camera
  $('game').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const SKY = 0xa8d8ff;
  scene.background = new THREE.Color(SKY);
  scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);

  // Height haze: replace three.js's fog (a flat wall at a set depth) with one that also fades out anything
  // outside an oval on the ground around the rider, stretched forward so you can see where you're heading.
  const HAZE_U = {
    hazeCenter: { value: new THREE.Vector2() },  // rider's x, z
    hazeFwd: { value: new THREE.Vector2(0, -1) }, // direction of travel on the ground
    hazeRadii: { value: new THREE.Vector3(1e5, 1e5, 1e5) }, // ahead, behind, side (m)
    hazeOn: { value: 0 },
  };
  Object.assign(THREE.ShaderChunk, {
    fog_pars_vertex: '#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogWorld;\n#endif',
    fog_vertex: '#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n#endif',
    fog_pars_fragment: `#ifdef USE_FOG
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
      varying float vFogDepth; varying vec3 vFogWorld;
      uniform vec2 hazeCenter; uniform vec2 hazeFwd; uniform vec3 hazeRadii; uniform float hazeOn;
    #endif`,
    fog_fragment: `#ifdef USE_FOG
      float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
      if ( hazeOn > 0.5 ) {
        vec2 d = vFogWorld.xz - hazeCenter;
        float f = dot( d, hazeFwd );
        float s = d.x * hazeFwd.y - d.y * hazeFwd.x;
        float r = length( vec2( f / ( f > 0.0 ? hazeRadii.x : hazeRadii.y ), s / hazeRadii.z ) );
        fogFactor = max( fogFactor, smoothstep( 0.5, 1.0, r ) );
      }
      gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
    #endif`,
  });
  // Every built-in material picks up the shared haze uniforms when it compiles.
  THREE.Material.prototype.onBeforeCompile = function (shader) { Object.assign(shader.uniforms, HAZE_U); };

  const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.05, 1000);
  camera.rotation.order = 'YXZ';
  camera.layers.enable(LAYER_RIDER);
  camera.layers.enable(LAYER_FP);
  scene.add(camera);

  const chaseCam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 900);
  chaseCam.layers.enable(LAYER_RIDER);
  chaseCam.layers.enable(LAYER_HITTER);
  chaseCam.position.set(0, CLIFF_H + 5, 100);

  scene.add(new THREE.HemisphereLight(0xe6f4ff, 0x8a6a48, 0.8));
  const sun = new THREE.DirectionalLight(0xfff1d0, 0.9);
  sun.castShadow = true;
  sun.shadow.mapSize.set(TOUCH ? 1024 : 2048, TOUCH ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, near: 1, far: 260 });
  sun.shadow.bias = -0.0006;
  scene.add(sun, sun.target);
  function placeSun(x, y, z) {
    sun.position.set(x + 40, y + 90, z + 25);
    sun.target.position.set(x, y, z - 20);
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    layoutPip();
  });

  // ------------------------------------------------------------------
  // Textures (procedural)
  // ------------------------------------------------------------------
  function canvasTex(w, h, draw, rx = 1, ry = 1) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
  }
  const withRepeat = (tex, rx, ry) => { const t = tex.clone(); t.needsUpdate = true; t.repeat.set(rx, ry); return t; };

  const grassTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#62ad4b'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const s = rand(-18, 18);
      g.fillStyle = `rgb(${90 + s},${165 + s},${70 + s * 0.5})`;
      g.fillRect(rand(0, w), rand(0, h), 2, rand(2, 5));
    }
  });
  const dirtTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#a57d55'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 3500; i++) {
      const s = rand(-22, 22);
      g.fillStyle = `rgb(${165 + s},${125 + s},${85 + s})`;
      g.fillRect(rand(0, w), rand(0, h), rand(1, 3), rand(1, 3));
    }
    for (let i = 0; i < 60; i++) {
      const s = rand(-20, 20);
      g.fillStyle = `rgb(${130 + s},${120 + s},${110 + s})`;
      g.beginPath(); g.arc(rand(0, w), rand(0, h), rand(1.5, 3.5), 0, 7); g.fill();
    }
  }, 30, 6);
  const boostTex = canvasTex(128, 192, (g, w, h) => {
    g.fillStyle = '#222'; g.fillRect(0, 0, w, h);
    g.lineWidth = 16; g.strokeStyle = '#ffcc22';
    for (let i = 0; i < 3; i++) {
      const y = 40 + i * 52;
      g.beginPath(); g.moveTo(18, y + 34); g.lineTo(w / 2, y); g.lineTo(w - 18, y + 34); g.stroke();
    }
  });
  const qTex = canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#ffc93c'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#c47a00'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
    g.fillStyle = '#fff'; g.font = 'bold 90px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('?', w / 2, h / 2 + 4);
  });
  function textTex(lines, w, h, bg, fg, size) {
    return canvasTex(w, h, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.strokeStyle = fg; g.lineWidth = 6; g.strokeRect(6, 6, w - 12, h - 12);
      g.fillStyle = fg; g.font = `bold ${size}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      lines.forEach((t, k) => g.fillText(t, w / 2, h / 2 + (k - (lines.length - 1) / 2) * size * 1.15));
    });
  }
  function signTex(text) {
    return canvasTex(256, 128, (g, w, h) => {
      g.fillStyle = '#7a4a1e'; g.fillRect(0, 0, w, h);
      g.strokeStyle = '#f4e3c1'; g.lineWidth = 8; g.strokeRect(8, 8, w - 16, h - 16);
      g.fillStyle = '#f4e3c1'; g.font = 'bold 64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2 + 3);
    });
  }

  // ------------------------------------------------------------------
  // Shared geometry / materials
  // ------------------------------------------------------------------
  const lam = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, ...extra });
  const M = {
    dirt: lam(0xffffff, { map: dirtTex }),
    trunk: lam(0x7a5230),
    leaves: [lam(0x3f8f3a, { flatShading: true }), lam(0x2f7a33, { flatShading: true }), lam(0x5aa040, { flatShading: true })],
    bush: [lam(0x7d8a3c, { flatShading: true }), lam(0x9a8a4a, { flatShading: true }), lam(0x5f7a35, { flatShading: true })],
    wood: lam(0x9b7448),
    mole: lam(0x6b4423, { flatShading: true }),
    moleDirt: lam(0x553419, { flatShading: true }),
    moleFur: lam(0x3a3236),
    nose: lam(0xff8fa3),
    rock: lam(0x8a8a90, { flatShading: true }),
    cliff: lam(0x9a8470, { flatShading: true }),
    mud: lam(0x4a3220),
    boost: lam(0xffffff, { map: boostTex }),
    qbox: lam(0xffffff, { map: qTex }),
    cloud: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xb8b8b8, fog: false }),
    lowCloud: new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xa0a0a0, transparent: true, opacity: 0.82, depthWrite: false, fog: false }),
    wing: new THREE.MeshLambertMaterial({ color: 0x2979ff, side: THREE.DoubleSide }),
    hill: lam(0xb59a6e, { flatShading: true }),
  };
  const G = {
    trunk: new THREE.CylinderGeometry(0.22, 0.32, 2.4, 6),
    blob: new THREE.IcosahedronGeometry(1.8, 0),
    cone: new THREE.ConeGeometry(1.7, 4.2, 7),
    bush: new THREE.IcosahedronGeometry(1, 0),
    mole: new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2),
    clump: new THREE.DodecahedronGeometry(0.09, 0),
    moleHead: new THREE.SphereGeometry(0.13, 10, 8),
    nose: new THREE.SphereGeometry(0.035, 6, 5),
    rock: new THREE.DodecahedronGeometry(0.75, 0),
    bigRock: new THREE.DodecahedronGeometry(1, 0),
    mud: new THREE.CircleGeometry(1, 20),
    boost: new THREE.PlaneGeometry(2.6, 4),
    qbox: new THREE.BoxGeometry(1.4, 1.4, 1.4),
    cloud: new THREE.SphereGeometry(1, 8, 6),
    hill: new THREE.SphereGeometry(1, 10, 6),
    ground: new THREE.PlaneGeometry(320, CHUNK),
  };

  // ------------------------------------------------------------------
  // Sound (tiny WebAudio synth, no files)
  // ------------------------------------------------------------------
  const Sound = {
    ctx: null, noiseBuf: null, windGain: null, windFilter: null, buffers: {},
    init() {
      if (this.ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.6;
      this.windGain = this.ctx.createGain(); this.windGain.gain.value = 0;
      src.connect(f).connect(this.windGain).connect(this.ctx.destination); src.start();
      this.windFilter = f;
      // Sounds from the original game file, if sounds.js is present
      for (const [name, b64] of Object.entries(window.ORIGINAL_SOUNDS || {})) {
        const bin = atob(b64), arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        this.ctx.decodeAudioData(arr.buffer).then((buf) => { this.buffers[name] = buf; }).catch(() => {});
      }
    },
    play(name, gain = 1, rate = 1) {
      const buf = this.ctx && this.buffers[name];
      if (!buf) return false;
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = rate;
      const g = this.ctx.createGain(); g.gain.value = gain;
      src.connect(g).connect(this.ctx.destination); src.start();
      return true;
    },
    noise(dur, freq, gain, type = 'lowpass', freqTo = null, delay = 0) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + delay;
      const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf;
      const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t);
      if (freqTo) f.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
      const g = this.ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      src.connect(f).connect(g).connect(this.ctx.destination); src.start(t); src.stop(t + dur);
    },
    tone(freq, freqTo, dur, type = 'sine', gain = 0.3, delay = 0) {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + delay;
      const o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
      o.frequency.exponentialRampToValueAtTime(freqTo, t + dur);
      const g = this.ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + dur);
    },
    setWind(v) {
      if (!this.ctx) return;
      this.windGain.gain.setTargetAtTime(clamp(v, 0, 1) * 0.12, this.ctx.currentTime, 0.1);
      this.windFilter.frequency.setTargetAtTime(300 + v * 900, this.ctx.currentTime, 0.1);
    },
    whack() { if (this.play('swingthud')) return; this.noise(0.18, 1500, 0.9, 'bandpass'); this.tone(160, 50, 0.25, 'square', 0.35); },
    swing() { if (this.play('swing')) return; this.noise(0.25, 700, 0.3, 'bandpass', 2600); },
    boing(chain = 1) { if (this.play('mole', 1, 1 + 0.12 * (chain - 1))) return; const k = 1 + 0.15 * (chain - 1); this.tone(180 * k, 620 * k, 0.28, 'sine', 0.35); },
    oof() { this.tone(220, 90, 0.22, 'sawtooth', 0.12); },
    thud(v = 1) { if (this.play('thud', v)) return; this.noise(0.25, 380, 0.7 * v); this.tone(90, 40, 0.2, 'sine', 0.4 * v); },
    clatter() { this.noise(0.2, 3000, 0.15, 'bandpass'); },
    skid() { this.noise(0.6, 2500, 0.3, 'highpass', 900); },
    splat() { if (this.play('splat')) return; this.noise(0.45, 700, 0.9, 'lowpass', 120); this.tone(120, 35, 0.35, 'square', 0.3); },
    button() { this.play('button'); },
    sniff() { for (let i = 0; i < 5; i++) this.noise(0.05, 3800, 0.22, 'bandpass', null, 0.08 + i * 0.12); },
    pop() { if (this.play('button')) return; this.tone(700, 1600, 0.1, 'triangle', 0.3); },
    splash() { this.noise(0.35, 900, 0.4, 'lowpass', 300); },
    powerup() { if (this.play('sparkle', 0.8)) return; [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f * 1.01, 0.15, 'square', 0.12, i * 0.07)); },
    rocket() { this.noise(1.0, 300, 0.7, 'lowpass', 1400); },
    zap() { this.tone(300, 1200, 0.3, 'sawtooth', 0.15); },
    bad() { this.tone(300, 120, 0.3, 'square', 0.2); },
  };

  // ------------------------------------------------------------------
  // Model helpers
  // ------------------------------------------------------------------
  function rod(a, b, r, mat) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, dir.length(), 6), mat);
    m.position.copy(a).addScaledVector(dir, 0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    m.castShadow = true;
    return m;
  }
  const RIDER_COLORS = { jersey: lam(0xff5a36), shorts: lam(0x222244), skin: lam(0xf1c27d), helmet: lam(0xffd23f), shoe: lam(0x1a1a1a) };

  // Bike with a seated rider, facing -Z. `tumble` is centred so the bike spins about its middle.
  function buildBike() {
    const root = new THREE.Group();
    const tumble = new THREE.Group(); tumble.position.y = 0.55; root.add(tumble);
    const inner = new THREE.Group(); inner.position.y = -0.55; tumble.add(inner);
    const frameMat = lam(0x1e88e5), tyre = lam(0x1a1a1a), metal = lam(0xbbbbbb);
    const { jersey, shorts, skin, helmet } = RIDER_COLORS;

    const wheels = [];
    for (const z of [0.55, -0.55]) {
      const w = new THREE.Group();
      w.position.set(0, 0.34, z);
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.04, 8, 24), tyre);
      t.rotation.y = Math.PI / 2; w.add(t);
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.62, 0.012), metal);
        s.rotation.x = (i * Math.PI) / 3; w.add(s);
      }
      inner.add(w); wheels.push(w);
    }
    const bb = V(0, 0.32, 0.08), seat = V(0, 0.86, 0.26), head = V(0, 0.84, -0.38);
    [[bb, seat], [seat, head], [bb, head], [bb, V(0, 0.34, 0.55)], [seat, V(0, 0.34, 0.55)], [head, V(0, 0.34, -0.55)]]
      .forEach(([a, b]) => inner.add(rod(a, b, 0.025, frameMat)));
    inner.add(rod(V(0, 0.84, -0.38), V(0, 0.98, -0.44), 0.02, metal));
    inner.add(rod(V(-0.24, 0.98, -0.44), V(0.24, 0.98, -0.44), 0.018, metal));
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.26), tyre);
    saddle.position.set(0, 0.9, 0.26); inner.add(saddle);
    const crank = new THREE.Group(); crank.position.copy(bb);
    crank.add(rod(V(0, 0.15, 0), V(0, -0.15, 0), 0.015, metal));
    inner.add(crank);

    // Seated rider (hidden once they're knocked off)
    const rider = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.55, 0.22), jersey);
    torso.position.set(0, 1.22, 0.05); torso.rotation.x = -0.75; rider.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.24), shorts);
    hips.position.set(0, 0.98, 0.24); rider.add(hips);
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), skin);
    headM.position.set(0, 1.5, -0.2); rider.add(headM);
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.15, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), helmet);
    helm.position.set(0, 1.53, -0.18); helm.rotation.x = -0.3; rider.add(helm);
    for (const s of [-1, 1]) {
      rider.add(rod(V(s * 0.17, 1.38, -0.12), V(s * 0.22, 0.99, -0.44), 0.04, skin));
      rider.add(rod(V(s * 0.1, 0.98, 0.24), V(s * 0.12, 0.62, -0.05), 0.055, shorts));
      rider.add(rod(V(s * 0.12, 0.62, -0.05), V(s * 0.12, 0.32 + s * 0.12, 0.08), 0.045, skin));
    }
    inner.add(rider);
    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    return { root, tumble, wheels, crank, rider };
  }

  // Rider lying face-down (superman pose), facing -Z, origin at the belly on the ground.
  function buildProne() {
    const root = new THREE.Group();
    const body = new THREE.Group(); body.position.y = 0.16; root.add(body);
    const { jersey, shorts, skin, helmet, shoe } = RIDER_COLORS;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.24, 0.62), jersey);
    torso.position.set(0, 0, -0.1); body.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.26), shorts);
    hips.position.set(0, -0.01, 0.32); body.add(hips);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), skin);
    head.position.set(0, 0.06, -0.55); body.add(head);
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), helmet);
    helm.position.set(0, 0.07, -0.57); helm.rotation.x = -1.2; body.add(helm);
    const arms = [], legs = [];
    for (const s of [-1, 1]) {
      const arm = new THREE.Group(); arm.position.set(s * 0.2, 0.04, -0.34);
      arm.add(rod(V(0, 0, 0), V(s * 0.08, 0.08, -0.6), 0.045, jersey));
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), skin); hand.position.set(s * 0.09, 0.09, -0.65); arm.add(hand);
      body.add(arm); arms.push(arm);
      const leg = new THREE.Group(); leg.position.set(s * 0.1, -0.01, 0.42);
      leg.add(rod(V(0, 0, 0), V(s * 0.06, 0.02, 0.72), 0.06, skin));
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.16), shoe); foot.position.set(s * 0.06, 0.04, 0.78); leg.add(foot);
      body.add(leg); legs.push(leg);
    }
    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    setLayer(root, LAYER_RIDER);
    return { root, body, arms, legs };
  }

  // First-person bat (child of camera). Swings left-to-right across the screen.
  function buildBat() {
    const pivot = new THREE.Group();
    pivot.position.set(-0.3, -0.5, -0.42);
    pivot.rotation.order = 'YZX';
    const geo = new THREE.CylinderGeometry(0.055, 0.022, 0.95, 12);
    geo.rotateZ(-Math.PI / 2); geo.translate(0.5, 0, 0);
    const bat = new THREE.Mesh(geo, lam(0xc89b5e));
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.18, 8).rotateZ(-Math.PI / 2).translate(0.05, 0, 0), lam(0x222222));
    const glove = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.1), lam(0xd23b3b));
    glove.position.set(0.04, 0, 0);
    pivot.add(bat, grip, glove);
    setLayer(pivot, LAYER_FP);
    camera.add(pivot);
    return pivot;
  }

  // First-person outstretched arms for the rider (child of camera).
  function buildFPArms() {
    const g = new THREE.Group();
    const arms = [];
    for (const s of [-1, 1]) {
      const a = new THREE.Group(); a.position.set(s * 0.3, -0.32, -0.1);
      a.add(rod(V(0, 0, 0), V(-s * 0.1, 0.06, -0.55), 0.032, RIDER_COLORS.jersey));
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), RIDER_COLORS.skin);
      hand.scale.set(1, 0.6, 1.3); hand.position.set(-s * 0.105, 0.065, -0.6); a.add(hand);
      g.add(a); arms.push(a);
    }
    g.traverse((o) => { if (o.isMesh) o.castShadow = false; });
    setLayer(g, LAYER_FP);
    camera.add(g);
    return { g, arms };
  }

  // The hitter's body, only seen in the follow cam.
  function buildHitter() {
    const root = new THREE.Group();
    const shirt = lam(0x2e7d32), jeans = lam(0x34495e), skin = lam(0xe0ac69);
    for (const s of [-1, 1]) root.add(rod(V(0, 0, s * 0.12), V(0, 0.85, s * 0.1), 0.07, jeans));
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.6, 0.42), shirt); torso.position.y = 1.15; root.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), skin); head.position.y = 1.6; root.add(head);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), lam(0xd23b3b));
    cap.position.y = 1.63; root.add(cap);
    const batPivot = new THREE.Group(); batPivot.position.set(-0.25, 1.15, 0); batPivot.rotation.order = 'YZX';
    const geo = new THREE.CylinderGeometry(0.055, 0.022, 0.95, 10); geo.rotateZ(-Math.PI / 2); geo.translate(0.5, 0, 0);
    batPivot.add(new THREE.Mesh(geo, lam(0xc89b5e)));
    root.add(batPivot);
    root.position.copy(HITTER_POS);
    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    setLayer(root, LAYER_HITTER);
    scene.add(root);
    return { root, batPivot };
  }

  // A mole that pops up in front of your face (child of camera).
  function buildFPMole() {
    const g = new THREE.Group();
    const fur = lam(0x4a3f45), pink = lam(0xff8fa3), black = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), fur); head.scale.set(1.1, 0.95, 1); g.add(head);
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.18, 12), fur);
    snout.rotation.x = Math.PI / 2; snout.position.set(0, -0.03, 0.2); g.add(snout);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), pink); nose.position.set(0, -0.03, 0.3); g.add(nose);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), black); eye.position.set(s * 0.07, 0.06, 0.14); g.add(eye);
      const paw = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), pink);
      paw.scale.set(1.2, 0.5, 0.9); paw.position.set(s * 0.17, -0.14, 0.1); g.add(paw);
    }
    const whiskers = [];
    for (const s of [-1, 1]) for (let k = 0; k < 3; k++) {
      const pivot = new THREE.Group(); pivot.position.set(s * 0.04, -0.03 + (k - 1) * 0.015, 0.26);
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.004, 0.004), black); w.position.x = s * 0.08; pivot.add(w);
      pivot.userData.base = s * (k - 1) * 0.25; pivot.rotation.z = pivot.userData.base;
      g.add(pivot); whiskers.push(pivot);
    }
    const dirt = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), M.mole);
    dirt.position.y = -0.22; dirt.scale.set(1.2, 0.5, 1); g.add(dirt);
    g.visible = false;
    setLayer(g, LAYER_FP);
    camera.add(g);
    return { g, nose, whiskers };
  }

  // A cross mole that pops out to flip you off when you stop near its molehill.
  function buildRudeMole() {
    const g = new THREE.Group();
    const fur = lam(0x4a3f45), pink = lam(0xff8fa3), black = new THREE.MeshBasicMaterial({ color: 0x111111 });
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.2, 14, 10), fur); body.scale.set(1, 1.2, 0.9); body.position.y = 0.15; g.add(body);
    const head = new THREE.Group(); head.position.y = 0.42; g.add(head);
    head.add(new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 10), fur));
    const snout = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.17, 10), fur); snout.rotation.x = Math.PI / 2; snout.position.set(0, -0.03, 0.18); head.add(snout);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 6), pink); nose.position.set(0, -0.03, 0.27); head.add(nose);
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), black); eye.position.set(s * 0.065, 0.05, 0.13); head.add(eye);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.015, 0.015), black);
      brow.position.set(s * 0.065, 0.09, 0.135); brow.rotation.z = s * 0.45; head.add(brow); // cross eyebrows
    }
    const rest = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), pink); rest.scale.set(1.2, 0.6, 1); rest.position.set(-0.2, 0.12, 0.1); g.add(rest);
    // raised arm with one finger up
    const arm = new THREE.Group(); arm.position.set(0.17, 0.28, 0.04); g.add(arm);
    arm.add(rod(V(0, 0, 0), V(0.04, 0.24, 0.03), 0.04, fur));
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.08, 0.08), pink); fist.position.set(0.045, 0.28, 0.035); arm.add(fist);
    const finger = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.12, 8), pink); finger.position.set(0.045, 0.37, 0.05); arm.add(finger);
    g.scale.setScalar(2.2);
    g.visible = false;
    scene.add(g);
    return { g, head, arm };
  }

  function tri(a, b, c, mat) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
    g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }
  function buildWingPickup() {
    const g = new THREE.Group();
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.8, 0.3), new THREE.MeshPhongMaterial({ color: 0x2979ff, emissive: 0x0d47a1 }));
    g.add(pack);
    for (const s of [-1, 1]) g.add(tri([0, 0.35, 0], [s * 1.4, 0.1, 0], [0, -0.35, 0], M.wing));
    g.userData.spin = true;
    return g;
  }
  // Wingsuit membranes on the first-person arms and on the third-person rider
  function addWings(parent, pts, layer) {
    const w = new THREE.Group();
    for (const s of [-1, 1]) w.add(tri(...pts(s), M.wing));
    setLayer(w, layer); w.visible = false; parent.add(w);
    return w;
  }

  const bike = buildBike();
  scene.add(bike.root);
  const prone = buildProne();
  scene.add(prone.root);
  prone.root.visible = false;
  const bat = buildBat();
  const fpArms = buildFPArms();
  const hitter = buildHitter();
  const fpMole = buildFPMole();
  const rudeMole = buildRudeMole();
  const fpWings = addWings(camera, (s) => [[s * 0.3, -0.34, -0.1], [s * 0.2, -0.27, -0.7], [s * 0.9, -0.55, 0.05]], LAYER_FP);
  const proneWings = addWings(prone.body, (s) => [[s * 0.29, 0.13, -0.95], [s * 0.15, 0.0, 0.55], [s * 0.85, 0.05, 0.0]], LAYER_RIDER);
  const flipLook = new THREE.Vector3();

  // ------------------------------------------------------------------
  // 3D models (models.js): Dave (cyclist), Bob (batter) and the bike.
  // They load at start-up and replace the simple shapes above, which stay as a fallback.
  // Character: Quaternius "Universal Base Characters" (CC0). Bike: "Bicycle" by jeremy, Poly Pizza (CC-BY 3.0).
  // ------------------------------------------------------------------
  const DAVE_LOOK = { shirt: 0xc62828, stripe: 0xf5f5f5, pants: 0x1e4fa8, shoes: 0x222222, sleeve: 0.36, hair: 'Hair_Beard', hairTint: 0xffffff, helmet: 0xd32f2f };
  const BOB_LOOK = { shirt: 0x5b7f3a, stripe: null, pants: 0x9a8a5e, shoes: 0x4a3222, sleeve: 0.69, hair: 'Hair_Buzzed', hairTint: 0x5a4030, helmet: null };
  const people = { ready: false };
  const _pv = [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector3());
  const _pq = [0, 1, 2].map(() => new THREE.Quaternion());

  // Paint clothes onto the bare base body, by where each point sits in the rest (T) pose.
  function dressMaterial(mat, look) {
    const U = {
      cShirt: { value: new THREE.Color(look.shirt) }, cStripe: { value: new THREE.Color(look.stripe || look.shirt) },
      cPants: { value: new THREE.Color(look.pants) }, cShoes: { value: new THREE.Color(look.shoes) },
      sleeveX: { value: look.sleeve }, stripes: { value: look.stripe ? 1 : 0 },
    };
    mat.customProgramCacheKey = () => 'dressed';
    mat.onBeforeCompile = function (shader) {
      THREE.Material.prototype.onBeforeCompile.call(this, shader); // the shared haze uniforms
      Object.assign(shader.uniforms, U);
      shader.vertexShader = 'varying vec3 vBind;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvBind = position;');
      shader.fragmentShader = 'varying vec3 vBind;\nuniform vec3 cShirt, cStripe, cPants, cShoes;\nuniform float sleeveX, stripes;\n' +
        shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
          float ax = abs(vBind.x), y = vBind.y; vec3 cloth = vec3(-1.0);
          if (y < 0.13) cloth = cShoes;
          else if (y < 0.99 && ax < 0.3) cloth = cPants;
          else if ((y < 1.49 || (y < 1.56 && ax > 0.09)) && ax < sleeveX) {
            cloth = cShirt;
            if (stripes > 0.5 && ax < 0.24 && fract(vBind.x * 11.0 + 0.5) < 0.2) cloth = cStripe;
          }
          if (cloth.r >= 0.0) diffuseColor.rgb = cloth * (0.82 + 0.18 * dot(diffuseColor.rgb, vec3(0.6)));
        }`);
    };
    return mat;
  }

  function decodeModel(loader, b64) {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new Promise((res, rej) => loader.parse(bin.buffer, '', res, rej));
  }

  function makePerson(gltf, look) {
    const model = gltf.scene;
    const wrap = new THREE.Group();          // faces -Z like everything else in the game
    const turn = new THREE.Group(); turn.rotation.y = Math.PI;
    wrap.add(turn); turn.add(model);
    const B = {}, bones = [];
    model.traverse((n) => {
      if (n.isBone) { B[n.name] = n; bones.push(n); }
      if (n.isMesh) {
        const old = n.material;
        if (old.map) old.map.encoding = THREE.LinearEncoding; // the game renders without sRGB conversion
        n.material = new THREE.MeshLambertMaterial({ map: old.map, color: old.name === 'Hair' ? look.hairTint : 0xffffff });
        if (old.name === 'Body') dressMaterial(n.material, look);
        n.castShadow = true; n.frustumCulled = false;
      }
    });
    // Hair: keep one style and pin it (and the helmet) to the head bone.
    model.updateMatrixWorld(true);
    const toHead = B.Head.matrixWorld.clone().invert();
    for (const name of ['Hair_Beard', 'Hair_Buzzed']) {
      const h = model.getObjectByName(name);
      if (!h) continue;
      if (name !== look.hair) { h.parent.remove(h); continue; }
      h.applyMatrix4(toHead); B.Head.add(h);
    }
    if (look.helmet) {
      const g = new THREE.SphereGeometry(0.135, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55);
      const helm = new THREE.Mesh(g, lam(look.helmet));
      helm.scale.set(1.05, 0.95, 1.22); helm.position.set(0, 1.715, -0.012); helm.rotation.x = -0.12;
      helm.castShadow = true;
      helm.applyMatrix4(toHead); B.Head.add(helm);
    }
    for (const b of bones) b.userData.rest = b.quaternion.clone();
    return { wrap, model, B, bones };
  }

  function resetPose(p) {
    for (const b of p.bones) b.quaternion.copy(b.userData.rest);
    p.wrap.updateWorldMatrix(true, true);
  }
  // Rotate a bone by a world-space rotation.
  function rotWorld(bone, q) {
    bone.parent.getWorldQuaternion(_pq[0]);
    _pq[1].copy(_pq[0]).invert().multiply(q).multiply(_pq[0]);
    bone.quaternion.premultiply(_pq[1]);
    bone.updateMatrixWorld(true);
  }
  // Swing a bone so its child joint points at a world position.
  function aim(bone, child, target) {
    bone.getWorldPosition(_pv[0]); child.getWorldPosition(_pv[1]);
    _pv[1].sub(_pv[0]).normalize();
    _pv[2].copy(target).sub(_pv[0]).normalize();
    rotWorld(bone, _pq[2].setFromUnitVectors(_pv[1], _pv[2]));
  }
  // Two-bone reach (thigh-calf-foot or upper arm-forearm-hand), bending toward `pole` (a world direction).
  function reach(a, b, c, target, pole) {
    const A = a.getWorldPosition(new THREE.Vector3()), Bp = b.getWorldPosition(new THREE.Vector3()), C = c.getWorldPosition(new THREE.Vector3());
    const l1 = A.distanceTo(Bp), l2 = Bp.distanceTo(C);
    const d = target.clone().sub(A);
    const dist = clamp(d.length(), Math.abs(l1 - l2) + 0.01, l1 + l2 - 0.005); d.normalize();
    const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const bend = pole.clone().addScaledVector(d, -pole.dot(d)).normalize();
    const mid = A.clone().addScaledVector(d, l1 * cosA).addScaledVector(bend, l1 * sinA);
    aim(a, b, mid);
    aim(b, c, A.addScaledVector(d, dist));
  }
  const worldAxis = (obj, x, y, z) => new THREE.Vector3(x, y, z).transformDirection(obj.matrixWorld);
  const turnBone = (bone, axis, ang) => rotWorld(bone, new THREE.Quaternion().setFromAxisAngle(axis, ang));

  function loadModels() {
    if (!window.HTC_MODELS || !THREE.GLTFLoader) return;
    const L = new THREE.GLTFLoader(), M_ = window.HTC_MODELS;
    Promise.all([decodeModel(L, M_.man), decodeModel(L, M_.man), decodeModel(L, M_.man), decodeModel(L, M_.bike)])
      .then(([g1, g2, g3, gb]) => {
        setupBike(gb);
        people.seated = makePerson(g1, DAVE_LOOK);
        people.prone = makePerson(g2, DAVE_LOOK);
        people.bob = makePerson(g3, BOB_LOOK);
        setupSeated(); setupProne(); setupBob();
        people.ready = true;
      })
      .catch((e) => console.warn('3D models failed to load; using simple shapes', e));
  }

  // Swap the simple bike for the model (frame recoloured to the original's dark red).
  function setupBike(gltf) {
    const inner = bike.tumble.children[0];
    for (const c of inner.children) if (c !== bike.rider) c.visible = false;
    const g = new THREE.Group(); g.position.z = 0.2; // centre the wheelbase on the tumble pivot
    const mats = { FF5722: lam(0x9b1c1c), '1A1A1A': lam(0x1c1c1c), '78909C': lam(0x9aa7b0) };
    const parts = {};
    for (const n of [...gltf.scene.children]) {
      n.traverse((m) => { if (m.isMesh) { m.material = mats[m.material.name] || lam(0x888888); m.castShadow = true; } });
      parts[n.name] = n; g.add(n);
    }
    inner.add(g);
    bike.wheels.length = 0; bike.wheels.push(parts.WheelF, parts.WheelR);
    bike.crank = parts.Crank;
    // Contact points for the rider, from the frame's geometry (in the bike's own space).
    const saddle = new THREE.Vector3(0, -1, 0), grip = new THREE.Vector3(), v = new THREE.Vector3(); let gn = 0;
    parts.Frame.traverse((m) => {
      if (!m.isMesh || m.material !== mats['1A1A1A']) return;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        if (v.z > 0 && v.y > saddle.y) saddle.copy(v);
        if (Math.abs(v.x) > 0.17 && v.y > 0.75 && v.z < -0.4) { grip.x += Math.abs(v.x); grip.y += v.y; grip.z += v.z; gn++; }
      }
    });
    grip.divideScalar(Math.max(gn, 1));
    bike.fit = { saddle: saddle.add(g.position), grip: grip.add(g.position), bb: parts.Crank.position.clone().add(g.position) };
  }

  function setupSeated() {
    const p = people.seated;
    for (const c of bike.rider.children) c.visible = false;
    bike.rider.add(p.wrap);
    resetPose(p);
    const pelvis = p.wrap.worldToLocal(p.B.pelvis.getWorldPosition(new THREE.Vector3()));
    p.wrap.position.copy(bike.fit.saddle).add(new THREE.Vector3(0, 0.07, 0.05)).sub(pelvis);
  }

  function setupProne() {
    const p = people.prone;
    for (const c of prone.body.children) if (c !== proneWings) c.visible = false;
    // lie face-down, head forward, belly at the origin
    p.wrap.rotation.x = -Math.PI / 2;
    p.wrap.position.set(0, 0.12, 1.1);
    prone.body.add(p.wrap);
    setLayer(p.wrap, LAYER_RIDER);
  }

  function setupBob() {
    const p = people.bob;
    for (const c of hitter.root.children) if (c !== hitter.batPivot) c.visible = false;
    p.wrap.rotation.y = Math.PI / 2; // he faces -X in the hitter's space, where the bat sweeps
    hitter.root.add(p.wrap);
    setLayer(p.wrap, LAYER_HITTER);
  }

  function poseSeated() {
    const p = people.seated, B_ = p.B;
    resetPose(p);
    const W = p.wrap;
    const fwd = worldAxis(W, 1, 0, 0);
    turnBone(B_.pelvis, fwd, -0.55);                              // lean forward over the bars
    turnBone(B_.spine_01, fwd, -0.25);
    turnBone(B_.spine_02, fwd, -0.2);
    turnBone(B_.neck_01, fwd, 0.6);                               // look up the road
    turnBone(B_.Head, fwd, 0.35);
    const parent = bike.rider, fit = bike.fit;
    for (const [s, side] of [[-1, 'l'], [1, 'r']]) {
      const grip = parent.localToWorld(new THREE.Vector3(s * fit.grip.x, fit.grip.y, fit.grip.z));
      reach(B_['upperarm_' + side], B_['lowerarm_' + side], B_['hand_' + side], grip, worldAxis(W, s * 0.7, -1, 0.4));
      const a = bike.crank.rotation.x + (s < 0 ? Math.PI : 0);
      const pedal = new THREE.Vector3(s * 0.12, fit.bb.y + Math.sin(a) * 0.17 + 0.07, fit.bb.z - Math.cos(a) * 0.17);
      reach(B_['thigh_' + side], B_['calf_' + side], B_['foot_' + side], parent.localToWorld(pedal), worldAxis(W, s * 0.15, 0.4, -1));
    }
  }

  function poseProne() {
    const p = people.prone, B_ = p.B, body = prone.body;
    resetPose(p);
    turnBone(B_.neck_01, worldAxis(body, 1, 0, 0), 0.5);         // lift the head to see ahead
    turnBone(B_.Head, worldAxis(body, 1, 0, 0), 0.35);
    const tgt = new THREE.Vector3();
    prone.arms.forEach((arm, i) => {
      const s = i ? 1 : -1, side = i ? 'r' : 'l';
      const rx = arm.rotation.x, rz = arm.rotation.z;
      const dir = worldAxis(body, s * 0.3 + Math.sin(rz) * s * -0.9, 0.1 + Math.sin(rx) * 0.9, -1).normalize();
      aim(B_['upperarm_' + side], B_['lowerarm_' + side], B_['upperarm_' + side].getWorldPosition(tgt).addScaledVector(dir, 1));
      aim(B_['lowerarm_' + side], B_['hand_' + side], B_['lowerarm_' + side].getWorldPosition(tgt).addScaledVector(dir, 1));
    });
    prone.legs.forEach((leg, i) => {
      const s = i ? 1 : -1, side = i ? 'r' : 'l';
      const rx = leg.rotation.x;
      const dir = worldAxis(body, s * 0.1, 0.04 + Math.sin(rx) * 0.6, 1).normalize();
      aim(B_['thigh_' + side], B_['calf_' + side], B_['thigh_' + side].getWorldPosition(tgt).addScaledVector(dir, 1));
      const shin = worldAxis(body, s * 0.1, 0.04 + Math.sin(rx) * 0.6 + Math.max(0, Math.sin(rx)) * 0.8, 1).normalize();
      aim(B_['calf_' + side], B_['foot_' + side], B_['calf_' + side].getWorldPosition(tgt).addScaledVector(shin, 1));
    });
  }

  function poseBob() {
    const p = people.bob, B_ = p.B, root = hitter.root;
    resetPose(p);
    // the chest turns with the bat, the hands stay on the handle
    const twist = (hitter.batPivot.rotation.y + Math.PI) * 0.55;
    turnBone(B_.spine_02, worldAxis(root, 0, 1, 0), twist);
    turnBone(B_.pelvis, worldAxis(root, 0, 1, 0), twist * 0.3);
    for (const side of ['l', 'r']) {
      const k = side === 'l' ? 1 : -1;
      turnBone(B_['thigh_' + side], worldAxis(root, 1, 0, 0), k * 0.12); // feet apart
    }
    hitter.batPivot.updateMatrixWorld(true);
    const out = worldAxis(root, 0, 0, 1);
    reach(B_.upperarm_r, B_.lowerarm_r, B_.hand_r, hitter.batPivot.localToWorld(new THREE.Vector3(0.04, 0, 0)), out.clone().negate().add(new THREE.Vector3(0, -1, 0)));
    reach(B_.upperarm_l, B_.lowerarm_l, B_.hand_l, hitter.batPivot.localToWorld(new THREE.Vector3(0.14, 0, 0)), out.clone().add(new THREE.Vector3(0, -1, 0)));
  }

  function posePeople() {
    if (!people.ready) return;
    if (bike.root.visible && bike.rider.visible) poseSeated();
    if (prone.root.visible) poseProne();
    if (!$('pip').classList.contains('hidden') && (phase === 'hitter' || phase === 'launch')) poseBob();
  }
  loadModels();

  // ------------------------------------------------------------------
  // The cliff top (static): grass, approach road, rocky face
  // ------------------------------------------------------------------
  function buildCliff() {
    const top = lam(0xffffff, { map: withRepeat(dirtTex, 30, 21) });
    const box = new THREE.Mesh(new THREE.BoxGeometry(320, CLIFF_H, 220), [M.cliff, M.cliff, top, M.cliff, M.cliff, M.cliff]);
    box.position.set(0, CLIFF_H / 2, 110); box.receiveShadow = true;
    scene.add(box);
    const track = new THREE.Mesh(new THREE.PlaneGeometry(4, 220), lam(0xb08a62, { map: withRepeat(dirtTex, 0.4, 21) }));
    track.rotation.x = -Math.PI / 2; track.position.set(0, CLIFF_H + 0.02, 110); track.receiveShadow = true;
    scene.add(track);
    // two grass patches across the track: the cyclist rides through both. Hitting is possible from the
    // start of the first to the end of the second; the dirt gap between them is the perfect spot.
    const patchLen = HIT_WINDOW - PATCH_GAP;
    for (const side of [1, -1]) {
      const zc = SWEET_Z + side * (PATCH_GAP + patchLen / 2);
      const patch = new THREE.Mesh(new THREE.PlaneGeometry(6, patchLen), lam(0xffffff, { map: withRepeat(grassTex, 1.5, 0.4) }));
      patch.rotation.x = -Math.PI / 2; patch.position.set(0, CLIFF_H + 0.03, zc); patch.receiveShadow = true;
      scene.add(patch);
      for (let k = 0; k < 16; k++) {
        const tuft = new THREE.Mesh(G.bush, M.leaves[k % 3]);
        tuft.scale.set(0.1, 0.16, 0.1);
        tuft.position.set(rand(-2.9, 2.9), CLIFF_H + 0.05, zc + rand(-patchLen / 2, patchLen / 2));
        scene.add(tuft);
      }
    }
    // easter egg: a warning sign at the edge
    const warn = new THREE.Group();
    const wtex = textTex(['NO CYCLING', 'OFF THE CLIFF'], 256, 128, '#c62828', '#fff', 34);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), lam(0xffffff, { map: wtex }));
    board.position.y = 1.6; warn.add(board);
    const wpost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.6, 0.1), M.wood); wpost.position.set(0, 0.8, -0.06); warn.add(wpost);
    warn.position.set(-3.4, CLIFF_H, 1.5); warn.rotation.y = 0.35;
    warn.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(warn);
    // jagged rocks along the cliff face
    for (let x = -160; x <= 160; x += rand(2, 3.5)) {
      const r = new THREE.Mesh(G.bigRock, M.cliff);
      const s = rand(2, 4.5);
      r.scale.set(s, s * rand(0.8, 1.4), s * 0.6);
      r.position.set(x, rand(2, CLIFF_H - s * 1.5), rand(0.4, 1.2));
      r.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
      scene.add(r);
    }
    // trees on the cliff top
    const g = new THREE.Group();
    for (let k = 0; k < 30; k++) {
      const s = Math.random() < 0.5 ? -1 : 1;
      addTree(g, s * rand(12, 150), rand(20, 215));
    }
    for (let k = 0; k < 60; k++) {
      const s = Math.random() < 0.5 ? -1 : 1;
      const b = new THREE.Mesh(G.bush, M.bush[k % 3]);
      const sc = rand(0.4, 1.1);
      b.scale.set(sc, sc * 0.7, sc); b.position.set(s * rand(8, 150), sc * 0.3, rand(4, 215)); b.castShadow = true;
      g.add(b);
    }
    g.position.y = CLIFF_H;
    scene.add(g);
  }

  function addTree(group, x, z) {
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(G.trunk, M.trunk); trunk.position.y = 1.2; t.add(trunk);
    const pine = Math.random() < 0.4;
    const top = new THREE.Mesh(pine ? G.cone : G.blob, M.leaves[(Math.random() * 3) | 0]);
    top.position.y = pine ? 4 : 3.4;
    t.add(top);
    const s = rand(0.8, 1.6); t.scale.set(s, s, s);
    t.position.set(x, 0, z); t.rotation.y = rand(0, 6);
    trunk.castShadow = top.castShadow = true;
    group.add(t);
  }

  // ------------------------------------------------------------------
  // The dirt plain below, generated in chunks
  // ------------------------------------------------------------------
  const chunks = new Map();   // index -> { group, textures[] }
  let objects = [];           // molehill, mud, boost, rock, qbox

  function makeMolehill(x, z) {
    const g = new THREE.Group();
    const r = rand(0.55, 0.75);
    const dome = new THREE.Mesh(G.mole, M.mole);
    dome.scale.set(r, rand(0.35, 0.45), r); dome.castShadow = dome.receiveShadow = true; g.add(dome);
    for (let i = 0; i < 4; i++) {
      const c = new THREE.Mesh(G.clump, M.moleDirt);
      const a = rand(0, 6.28), d = rand(0, r * 0.6);
      c.position.set(Math.cos(a) * d, 0.3 * (1 - d / r) + 0.05, Math.sin(a) * d); g.add(c);
    }
    let mole = null;
    if (Math.random() < 0.35) {
      mole = new THREE.Group();
      mole.add(new THREE.Mesh(G.moleHead, M.moleFur));
      const n = new THREE.Mesh(G.nose, M.nose); n.position.set(0, -0.01, 0.12); mole.add(n);
      mole.position.set(0, 0.36, 0); mole.rotation.y = Math.PI;
      g.add(mole);
    }
    g.position.set(x, 0, z);
    return { type: 'mole', x, z, r: r + 0.6, mesh: g, mole, used: false };
  }

  // ---- Mud: irregular blobs with a few varieties
  const MUD_TYPES = [
    { name: 'Mud', color: 0x4a3220, fleck: 0x3a2516, slow: 9 },
    { name: 'Bog', color: 0x3b3a22, fleck: 0x2c2b18, slow: 13 },
    { name: 'Puddle', color: 0x6b5d50, fleck: 0x9fb4c0, slow: 6 },
    { name: 'Clay', color: 0x7a4428, fleck: 0x5e331d, slow: 8 },
    { name: 'Sludge', color: 0x2e2a26, fleck: 0x45403a, slow: 11 },
  ];
  const mudMats = new Map();
  const mudMat = (c) => { if (!mudMats.has(c)) mudMats.set(c, lam(c)); return mudMats.get(c); };
  const MUD_N = 32;
  function blob(R) {
    const harm = [2, 3, 5].map((k, j) => ({ k, a: rand(0.05, [0.22, 0.14, 0.08][j]), p: rand(0, 6.28) }));
    const radii = [], shape = new THREE.Shape();
    for (let k = 0; k < MUD_N; k++) {
      const th = (k / MUD_N) * Math.PI * 2;
      const r = R * (1 + harm.reduce((sum, hm) => sum + hm.a * Math.sin(hm.k * th + hm.p), 0));
      radii.push(r);
      k === 0 ? shape.moveTo(r, 0) : shape.lineTo(r * Math.cos(th), r * Math.sin(th));
    }
    shape.closePath();
    return { geo: new THREE.ShapeGeometry(shape), radii };
  }
  function makeMud(x, z, R, type = MUD_TYPES[(Math.random() * MUD_TYPES.length) | 0]) {
    const { geo, radii } = blob(R);
    const sx = rand(0.7, 1.35), sz = rand(0.8, 1.8);
    const m = new THREE.Mesh(geo, mudMat(type.color));
    m.rotation.x = -Math.PI / 2; m.scale.set(sx, sz, 1); m.position.set(x, 0.02 + rand(0, 0.008), z);
    m.receiveShadow = true; m.userData.ownGeo = true;
    for (let k = 0; k < 2 + ((Math.random() * 3) | 0); k++) {
      const f = blob(R * rand(0.12, 0.3));
      const fl = new THREE.Mesh(f.geo, mudMat(type.fleck));
      const a = rand(0, 6.28), d = rand(0, R * 0.55);
      fl.position.set(Math.cos(a) * d, Math.sin(a) * d, 0.004); fl.userData.ownGeo = true;
      m.add(fl);
    }
    return { type: 'mud', x, z, mesh: m, radii, sx, sz, slow: type.slow, name: type.name, reach: R * Math.max(sx, sz) * 1.3 + 1 };
  }
  function inMud(o, px, pz) {
    const lx = (px - o.x) / o.sx, ly = -(pz - o.z) / o.sz;
    let th = Math.atan2(ly, lx); if (th < 0) th += Math.PI * 2;
    const f = (th / (Math.PI * 2)) * MUD_N, k = Math.floor(f) % MUD_N;
    return Math.hypot(lx, ly) < lerp(o.radii[k], o.radii[(k + 1) % MUD_N], f - Math.floor(f));
  }

  function genChunk(i) {
    const group = new THREE.Group();
    const textures = [];
    const z0 = -i * CHUNK, zc = z0 - CHUNK / 2;
    const zr = () => rand(z0 - CHUNK + 2, z0 - 2);

    const ground = new THREE.Mesh(G.ground, M.dirt);
    ground.rotation.x = -Math.PI / 2; ground.position.set(0, 0, zc); ground.receiveShadow = true;
    group.add(ground);

    // scrubby bushes and a few trees, well away from the play area
    for (let k = 0; k < 12; k++) {
      const s = Math.random() < 0.5 ? -1 : 1;
      const b = new THREE.Mesh(G.bush, M.bush[(Math.random() * 3) | 0]);
      const sc = rand(0.4, 1.1);
      b.scale.set(sc, sc * 0.7, sc); b.position.set(s * rand(PLAY_X + 4, 140), sc * 0.3, zr()); b.castShadow = true;
      group.add(b);
    }
    for (let k = 0; k < 5; k++) {
      const s = Math.random() < 0.5 ? -1 : 1;
      addTree(group, s * rand(35, 150), zr());
    }
    for (const s of [-1, 1]) {
      if (Math.random() < 0.7) {
        const h = new THREE.Mesh(G.hill, M.hill);
        h.scale.set(rand(40, 80), rand(12, 30), rand(30, 50));
        h.position.set(s * rand(160, 230), -2, zr()); group.add(h);
      }
    }
    if (Math.random() < 0.8) {
      const c = new THREE.Group();
      for (let k = 0; k < 5; k++) {
        const p = new THREE.Mesh(G.cloud, M.cloud);
        p.scale.set(rand(8, 14), rand(4, 6), rand(6, 10)); p.position.set(k * 8 - 16, rand(-2, 2), rand(-4, 4)); c.add(p);
      }
      c.position.set(rand(-220, 220), rand(80, 120), zr());
      group.add(c);
    }
    // distance sign (measured from the cliff edge)
    if (i >= 1) {
      const tex = signTex(`${i * CHUNK} m`); textures.push(tex);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), lam(0xffffff, { map: tex }));
      board.position.set(-PLAY_X - 3, 2.2, z0); board.castShadow = true;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.2, 0.15), M.wood); post.position.set(-PLAY_X - 3, 1.1, z0 + 0.1);
      group.add(board, post);
    }

    // interactive objects, all inside the play area. They thin out smoothly to 50% by 1000 m.
    const dens = 1 - 0.5 * clamp(((i + 0.5) * CHUNK) / DENSITY_FLOOR_AT, 0, 1);
    const keep = () => Math.random() < dens;
    const px = () => rand(-PLAY_X + 1, PLAY_X - 1);
    const n = 5 + ((Math.random() * 3) | 0);
    for (let k = 0; k < n; k++) {
      if (!keep()) continue;
      const o = makeMolehill(px(), zr());
      o.chunk = i; group.add(o.mesh); objects.push(o);
    }
    const nm = 1 + ((Math.random() * 3) | 0);
    for (let k = 0; k < nm; k++) {
      if (!keep()) continue;
      const o = makeMud(px(), zr(), rand(2.2, 5.5));
      o.chunk = i; group.add(o.mesh); objects.push(o);
    }
    for (const ep of eggPlan) if (ep.chunk === i) placeEgg(ep, group, i);
    if (Math.random() < 0.35 * dens) {
      const x = px(), z = zr();
      const b = new THREE.Mesh(G.boost, M.boost);
      b.rotation.x = -Math.PI / 2; b.position.set(x, 0.03, z);
      group.add(b); objects.push({ type: 'boost', x, z, mesh: b, chunk: i, used: false });
    }
    if (i >= 2) {
      const nr = (Math.random() * 3) | 0;
      for (let k = 0; k < nr; k++) {
        if (!keep()) continue;
        const x = px(), z = zr();
        const r = new THREE.Mesh(G.rock, M.rock);
        const sc = rand(1.6, 2.3); // ~1.2-1.7 m radius boulders
        r.scale.setScalar(sc);
        r.position.set(x, 0.45 * sc, z); r.rotation.set(rand(0, 3), rand(0, 3), 0); r.castShadow = true;
        group.add(r);
        objects.push({ type: 'rock', x, z, r: 0.75 * sc * 0.85 + 0.3, top: 0.45 * sc + 0.75 * sc * 0.8, mesh: r, chunk: i, used: false });
      }
    }
    // wingsuits, hidden in low clouds
    if (Math.random() < WINGSUIT_CHANCE) {
      const x = px(), z = zr(), y = rand(10, 24);
      const cl = new THREE.Group();
      for (let k = 0; k < 7; k++) {
        const puff = new THREE.Mesh(G.cloud, M.lowCloud);
        puff.scale.set(rand(2.2, 3.6), rand(1.4, 2.2), rand(2.2, 3.4));
        puff.position.set(rand(-3, 3), rand(-0.8, 0.8), rand(-3, 3));
        cl.add(puff);
      }
      const pick = buildWingPickup(); cl.add(pick);
      cl.position.set(x, y, z);
      group.add(cl);
      objects.push({ type: 'wing', x, y, z, mesh: cl, pick, chunk: i, used: false, reach: 6 });
    }
    // powerup pickups sit on the ground at random spots, and they're rare
    if (Math.random() < 0.12 * dens) {
      const x = px(), z = zr(), y = 0.75;
      const q = new THREE.Mesh(G.qbox, M.qbox);
      q.scale.setScalar(0.75);
      q.position.set(x, y, z); q.castShadow = true;
      group.add(q); objects.push({ type: 'qbox', x, y, z, mesh: q, chunk: i, used: false });
    }

    scene.add(group);
    chunks.set(i, { group, textures });
  }

  function removeChunk(i) {
    const c = chunks.get(i);
    scene.remove(c.group);
    c.group.traverse((o) => {
      if (o.isMesh && o.material.map && c.textures.includes(o.material.map)) { o.material.dispose(); o.geometry.dispose(); }
      else if (o.isMesh && o.userData.ownGeo) o.geometry.dispose();
    });
    c.textures.forEach((t) => t.dispose());
    chunks.delete(i);
    objects = objects.filter((o) => o.chunk !== i);
  }

  function updateChunks(z) {
    const dist = -z;
    const minI = Math.max(0, Math.floor((dist - KEEP_BEHIND) / CHUNK));
    const maxI = Math.max(0, Math.floor((dist + GEN_AHEAD) / CHUNK));
    for (const i of [...chunks.keys()]) if (i < minI) removeChunk(i);
    for (let i = minI; i <= maxI; i++) if (!chunks.has(i)) genChunk(i);
  }

  function resetWorld() {
    for (const i of [...chunks.keys()]) removeChunk(i);
    objects = [];
    updateChunks(0);
  }

  // ------------------------------------------------------------------
  // Easter eggs: 9 hidden around the plain (random spots each run) + 1 at the cliff edge
  // ------------------------------------------------------------------
  const EGGS = [
    { id: 'ufo', name: 'Cow abduction in progress', where: 'path' },
    { id: 'gnome', name: 'A very supportive gnome', where: 'path' },
    { id: 'duck', name: 'Rubber duck in the mud', where: 'path' },
    { id: 'snowman', name: 'A snowman, somehow', where: 'path' },
    { id: 'dino', name: 'Dinosaur bones', where: 'path' },
    { id: 'sofa', name: 'Someone left the telly on', where: 'path' },
    { id: 'golden', name: 'The golden molehill', where: 'path' },
    { id: 'treasure', name: 'X marks the spot', where: 'path' },
    { id: 'picnic', name: 'Mole family picnic', where: 'path' },
    { id: 'sign', name: 'You were warned', where: 'cliff' },
  ];
  const EGG_NAMES = Object.fromEntries(EGGS.map((e) => [e.id, e.name]));
  let eggPlan = [];
  let allEggs = new Set(JSON.parse(localStorage.getItem('pedalPanicEggs') || '[]'));

  function planEggs() {
    const world = EGGS.filter((e) => e.where !== 'cliff').sort(() => Math.random() - 0.5);
    // one egg every 500-1000 m
    let d = 0;
    eggPlan = world.map((egg) => {
      d += rand(EGG_GAP_MIN, EGG_GAP_MAX);
      return { egg, d, chunk: Math.floor(d / CHUNK) };
    });
  }

  // What each easter egg does when you hit it
  function applyEgg(o) {
    const fx = {
      treasure: () => { grantPowerup('Buried treasure'); o.chest.position.y = 0.4; },
      snowman: () => { P.icy = EGG_EFFECT_TIME; toast('🧊 Icy Belly: hardly any friction for 30 s', 'egg'); burst(o.x, 1.5, o.z, 20, 0xffffff, 5); o.mesh.rotation.x = -1.4; },
      gnome: () => { P.gnome = true; toast("🍄 Gnome's blessing: your next splut won't count", 'egg'); o.gone = true; o.mesh.visible = false; burst(o.x, 1, o.z, 14, 0xd32f2f, 4); },
      duck: () => { P.quack = EGG_EFFECT_TIME; toast('🦆 Quack! Mud can\'t slow you for 30 s', 'egg'); Sound.tone(900, 500, 0.15, 'square', 0.15); Sound.tone(850, 450, 0.15, 'square', 0.15, 0.18); },
      dino: () => { P.h += 15; P.vy = Math.max(P.vy, 6); P.onGround = false; toast('🦴 Fossil fuel! +54 km/h', 'egg'); Sound.zap(); burst(o.x, 1, o.z, 16, 0xf2ead8, 5); },
      sofa: () => { P.vy = Math.max(P.vy, 0) + 20; P.h += 4; P.onGround = false; toast('🛋️ Boing! The sofa springs launch you', 'egg'); Sound.boing(3); },
      picnic: () => { P.sugar = EGG_EFFECT_TIME; toast('🍰 Sugar rush: molehills 50% stronger for 30 s', 'egg'); burst(o.x, 0.5, o.z, 12, 0xe53935, 3); },
      ufo: () => { P.abduct = 2.5; P.chain = 0; toast('🛸 You are being abducted…', 'egg'); Sound.zap(); },
    }[o.id];
    if (fx) fx();
  }

  function findEgg(id) {
    if (!P.eggs || P.eggs.has(id)) return;
    P.eggs.add(id); allEggs.add(id);
    localStorage.setItem('pedalPanicEggs', JSON.stringify([...allEggs]));
    if (!Sound.play('sparkle', 0.8)) Sound.powerup();
    toast(`🥚 Easter egg ${P.eggs.size}/${EGGS.length}: ${EGG_NAMES[id]}`, 'egg');
  }

  const faceRider = (g, x) => { g.rotation.y = -Math.sign(x) * 0.6; };
  const EGG_BUILD = {
    ufo() {
      const g = new THREE.Group(), up = new THREE.Group(); up.position.y = 24; g.add(up);
      const saucer = new THREE.Mesh(new THREE.SphereGeometry(3, 20, 10), lam(0xb0b8c0)); saucer.scale.set(1, 0.25, 1); up.add(saucer);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(1.2, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshLambertMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.7 })); dome.position.y = 0.5; up.add(dome);
      for (let k = 0; k < 8; k++) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 4), new THREE.MeshBasicMaterial({ color: k % 2 ? 0xfff176 : 0x80ff80 }));
        l.position.set(Math.cos(k * 0.785) * 2.9, -0.1, Math.sin(k * 0.785) * 2.9); up.add(l);
      }
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 3.2, 24, 20, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xfff59d, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }));
      beam.position.y = 12; g.add(beam);
      const cow = new THREE.Group(), white = lam(0xffffff), blk = lam(0x222222);
      cow.add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.8, 0.7), white));
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), white); head.position.set(0.9, 0.25, 0); cow.add(head);
      for (const [x, z] of [[-0.5, -0.25], [-0.5, 0.25], [0.5, -0.25], [0.5, 0.25]]) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.5, 0.15), white); leg.position.set(x, -0.6, z); cow.add(leg);
      }
      for (let k = 0; k < 4; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.3, 0.72), blk); sp.position.set(rand(-0.5, 0.5), rand(-0.2, 0.2), 0); cow.add(sp); }
      g.add(cow);
      return { mesh: g, hitR: 3.5, hitH: 25, update: (t) => { up.rotation.y = t * 1.5; cow.position.y = 2 + ((t * 2) % 19); cow.rotation.set(t * 0.7, t * 0.5, 0); } };
    },
    gnome(x) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.5, 10), lam(0x1565c0)); body.position.y = 0.25; g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), lam(0xf1c27d)); head.position.y = 0.6; g.add(head);
      const beard = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.25, 8), lam(0xffffff)); beard.rotation.x = Math.PI; beard.position.set(0, 0.48, 0.08); g.add(beard);
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.4, 10), lam(0xd32f2f)); hat.position.y = 0.85; g.add(hat);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.3), lam(0xffffff, { map: textTex(['KEEP', 'GOING!'], 128, 64, '#fff8e1', '#1b5e20', 22) }));
      sign.position.set(0.35, 0.75, 0.05); g.add(sign);
      g.add(Object.assign(rod(V(0.35, 0, 0.04), V(0.35, 0.62, 0.04), 0.015, M.wood)));
      g.scale.setScalar(2.6); faceRider(g, x);
      return { mesh: g, hitR: 1.6, hitH: 2.5 };
    },
    duck() {
      const g = new THREE.Group(), y = lam(0xffeb3b);
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 10), y); body.scale.set(1, 0.75, 1.3); g.add(body);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), y); head.position.set(0, 0.35, 0.25); g.add(head);
      const beak = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.2, 8), lam(0xff9800)); beak.rotation.x = Math.PI / 2; beak.position.set(0, 0.33, 0.52); g.add(beak);
      for (const s of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 4), lam(0x111111)); e.position.set(s * 0.09, 0.42, 0.42); g.add(e); }
      g.scale.setScalar(1.6); g.rotation.y = Math.PI;
      return { mesh: g, hitR: 1.8, hitH: 1.2, mud: true, update: (t) => { g.position.y = 0.1 + Math.sin(t * 2) * 0.05; g.rotation.z = Math.sin(t * 1.3) * 0.1; } };
    },
    snowman(x) {
      const g = new THREE.Group(), w = lam(0xffffff);
      [[0.9, 0.8], [0.65, 2.0], [0.45, 2.95]].forEach(([r, y]) => { const b = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), w); b.position.y = y; b.castShadow = true; g.add(b); });
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.45, 8), lam(0xff7043)); nose.rotation.x = Math.PI / 2; nose.position.set(0, 2.95, 0.6); g.add(nose);
      for (const s of [-1, 1]) {
        const e = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 4), lam(0x111111)); e.position.set(s * 0.16, 3.1, 0.38); g.add(e);
        g.add(rod(V(s * 0.55, 2.1, 0), V(s * 1.3, 2.6, 0), 0.04, M.trunk));
      }
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.5, 12), lam(0x111111)); hat.position.y = 3.55; g.add(hat);
      const puddle = new THREE.Mesh(new THREE.CircleGeometry(1.6, 20), lam(0x90caf9)); puddle.rotation.x = -Math.PI / 2; puddle.position.y = 0.02; g.add(puddle);
      faceRider(g, x);
      return { mesh: g, hitR: 1.7, hitH: 4 };
    },
    dino(x) {
      const g = new THREE.Group(), bone = lam(0xf2ead8);
      g.add(rod(V(0, 1.6, -4), V(0, 1.8, 0), 0.12, bone)); g.add(rod(V(0, 1.8, 0), V(0, 1.2, 4), 0.1, bone));
      g.add(rod(V(0, 1.2, 4), V(0, 0.3, 7), 0.07, bone));
      for (let k = 0; k < 7; k++) {
        const rib = new THREE.Mesh(new THREE.TorusGeometry(1.5 - k * 0.12, 0.07, 6, 14, Math.PI), bone);
        rib.rotation.y = Math.PI / 2; rib.position.set(0, 0.2, -3 + k * 0.9); g.add(rib);
      }
      const skull = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.7, 1.4), bone); skull.position.set(0, 1.9, -5); skull.rotation.x = 0.3; g.add(skull);
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.15, 1.2), bone); jaw.position.set(0, 1.2, -5.3); jaw.rotation.x = 0.6; g.add(jaw);
      g.rotation.y = rand(-0.6, 0.6) + (x > 0 ? 0.3 : -0.3);
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      return { mesh: g, hitR: 3.5, hitH: 2.5 };
    },
    sofa(x) {
      const g = new THREE.Group(), red = lam(0xb71c1c);
      const base = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 0.9), red); base.position.y = 0.25; g.add(base);
      const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.8, 0.25), red); back.position.set(0, 0.7, -0.35); g.add(back);
      for (const s of [-1, 1]) { const a = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.7, 0.9), red); a.position.set(s * 1.25, 0.45, 0); g.add(a); }
      const stand = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.5), M.wood); stand.position.set(0, 0.25, 2.6); g.add(stand);
      const tv = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.85, 0.35), lam(0x222222)); tv.position.set(0, 0.95, 2.6); g.add(tv);
      const screenMat = new THREE.MeshBasicMaterial({ color: 0x4fc3f7 });
      const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.65), screenMat); screen.position.set(0, 0.95, 2.42); screen.rotation.y = Math.PI; g.add(screen);
      const rug = new THREE.Mesh(new THREE.PlaneGeometry(3, 3.2), lam(0x7b1fa2)); rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.02, 1.3); g.add(rug);
      g.rotation.y = x > 0 ? -Math.PI / 2 + 0.4 : Math.PI / 2 - 0.4;
      g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      return { mesh: g, hitR: 2.6, hitH: 1.6, update: (t) => screenMat.color.setHSL((Math.floor(t * 3) * 0.37) % 1, 0.7, 0.55) };
    },
    treasure() {
      const g = new THREE.Group(), red = lam(0xd32f2f);
      for (const r of [0.785, -0.785]) { const b = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.03, 0.35), red); b.rotation.y = r; b.position.y = 0.03; g.add(b); }
      const chest = new THREE.Group();
      chest.add(new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.45, 0.45), lam(0x6d4c41)));
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.08, 0.47), lam(0xffc107)); chest.add(band);
      chest.position.y = 0.05; chest.rotation.z = 0.25; g.add(chest);
      return { mesh: g, chest, hitR: 1.8, hitH: 1 };
    },
    picnic(x) {
      const g = new THREE.Group();
      const checks = canvasTex(64, 64, (c) => { for (let a = 0; a < 8; a++) for (let b = 0; b < 8; b++) { c.fillStyle = (a + b) % 2 ? '#e53935' : '#fff'; c.fillRect(a * 8, b * 8, 8, 8); } });
      const blanket = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), lam(0xffffff, { map: checks })); blanket.rotation.x = -Math.PI / 2; blanket.position.y = 0.03; g.add(blanket);
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Group(), fur = lam(0x4a3f45);
        const b = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), fur); b.scale.set(1, 1.1, 1); b.position.y = 0.2; m.add(b);
        const h = new THREE.Mesh(new THREE.SphereGeometry(0.15, 10, 8), fur); h.position.y = 0.48; m.add(h);
        const n = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 4), M.nose); n.position.set(0, 0.46, 0.16); m.add(n);
        const a = k * 2.1; m.position.set(Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0); m.rotation.y = Math.atan2(-m.position.x, -m.position.z);
        m.scale.setScalar(k === 2 ? 0.7 : 1); g.add(m);
      }
      const basket = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.35), lam(0xa1887f)); basket.position.y = 0.15; g.add(basket);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.02, 6, 12, Math.PI), lam(0xa1887f)); handle.position.y = 0.3; g.add(handle);
      g.scale.setScalar(1.5); faceRider(g, x);
      return { mesh: g, hitR: 2.6, hitH: 1.2 };
    },
  };

  function placeEgg(ep, group, i) {
    const id = ep.egg.id, z = -ep.d;
    if (id === 'golden') {
      const o = makeMolehill(rand(-6, 6), z);
      o.golden = true;
      o.mesh.traverse((m) => { if (m.isMesh) m.material = new THREE.MeshPhongMaterial({ color: 0xffc107, emissive: 0x6d4c00, shininess: 90 }); });
      o.mesh.scale.setScalar(1.3);
      o.chunk = i; group.add(o.mesh); objects.push(o);
      return;
    }
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = rand(-8, 8) + side * 0; // in the rider's path so you can hit it
    const e = EGG_BUILD[id](x);
    e.mesh.position.x = x; e.mesh.position.z = z;
    group.add(e.mesh);
    if (e.mud) {
      const m = makeMud(x, z, 3, MUD_TYPES[2]); m.chunk = i; group.add(m.mesh); objects.push(m);
    }
    objects.push({ type: 'egg', id, x, z, mesh: e.mesh, chest: e.chest, hitR: e.hitR, hitH: e.hitH, update: e.update, reach: 8, chunk: i, found: false });
  }

  // ------------------------------------------------------------------
  // Particles
  // ------------------------------------------------------------------
  const particles = [];
  const partGeo = new THREE.SphereGeometry(0.22, 6, 4);
  for (let k = 0; k < 90; k++) {
    const m = new THREE.Mesh(partGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true }));
    m.visible = false; scene.add(m);
    particles.push({ m, v: new THREE.Vector3(), life: 0, max: 1, floor: 0 });
  }
  let partIdx = 0;
  function burst(x, y, z, n, color, speed = 4, life = 0.8) {
    for (let k = 0; k < n; k++) {
      const p = particles[partIdx++ % particles.length];
      p.m.visible = true; p.m.position.set(x + rand(-0.5, 0.5), y + rand(0, 0.3), z + rand(-0.5, 0.5));
      p.m.material.color.setHex(color); p.m.material.opacity = 1;
      p.v.set(rand(-1, 1) * speed, rand(0.5, 1.5) * speed * 0.6, rand(-1, 1) * speed);
      p.life = p.max = life * rand(0.7, 1.2);
      p.floor = groundAt(z) + 0.1;
    }
  }
  function updateParticles(dt) {
    for (const p of particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.m.visible = false; continue; }
      p.v.y -= 6 * dt;
      p.m.position.addScaledVector(p.v, dt);
      if (p.m.position.y < p.floor) { p.m.position.y = p.floor; p.v.y = 0; p.v.x *= 0.9; p.v.z *= 0.9; }
      const k = p.life / p.max;
      p.m.material.opacity = k;
      p.m.scale.setScalar(1 + (1 - k) * 2);
    }
  }

  // ------------------------------------------------------------------
  // Powerups
  // ------------------------------------------------------------------
  const POWERUPS = {
    rocket: { icon: '🚀', name: 'Rocket' },
    jelly:  { icon: '🟢', name: 'Jelly Belly' },
    glide:  { icon: '☂️', name: 'Brolly Glide' },
    mole:   { icon: '⛰️', name: 'Mole Call' },
  };
  const PU_KEYS = Object.keys(POWERUPS);

  // ------------------------------------------------------------------
  // Game state
  // ------------------------------------------------------------------
  const mouse = { x: 0, y: 0 };      // -1..1
  const keys = {};
  let phase = 'title';               // title | hitter | launch | rider | results
  let best = +(localStorage.getItem('pedalPanicBest') || 0);
  let timeScale = 1;
  let shake = 0;
  let haze = 0; // 0 clear .. 1 ground fully faded out

  const H = { riderZ: 95, riderSpeed: 12, riding: false, spawnIn: 0, swingT: -1, contactChecked: false,
    launchT: 0, camYaw: 3 * Math.PI / 4, lastT: null };

  // The rider once they're off the bike
  const P = {
    x: 0, y: 0, z: 0, h: 0, vy: 0, yaw: 0, onGround: false,
    airTime: 0, stopT: 0, inv: [], jelly: 0, glide: 0, rocket: 0, steer: 0, squash: 0,
    stats: null, pitch: 0, roll: 0, wobble: 0, vx: 0, chain: 0, splut: 0, moleT: 0, splutKind: null,
  };
  // The bike once it's flying on its own
  const B = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0, active: false };

  // ------------------------------------------------------------------
  // HUD helpers
  // ------------------------------------------------------------------
  function toast(msg, cls = '') {
    const d = document.createElement('div');
    d.className = 'toast ' + cls; d.textContent = msg;
    $('toasts').appendChild(d);
    setTimeout(() => d.remove(), 3100);
    while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  }
  let bigTimer = 0;
  function bigText(msg, color = '#ffd23f', dur = 1.2) {
    const b = $('bigText'); b.textContent = msg; b.style.color = color; b.classList.add('show');
    clearTimeout(bigTimer); bigTimer = setTimeout(() => b.classList.remove('show'), dur * 1000);
  }
  function flash() {
    const f = $('flash'); f.classList.add('on');
    setTimeout(() => f.classList.remove('on'), 90);
  }
  function renderInventory() {
    const inv = $('inventory'); inv.innerHTML = '';
    for (let s = 0; s < MAX_SLOTS; s++) {
      const d = document.createElement('div');
      const id = P.inv[s];
      d.className = 'slot' + (id ? ' full' : '');
      d.dataset.slot = s;
      d.innerHTML = `<span class="key">${s + 1}</span>` + (id ? `<div class="icon">${POWERUPS[id].icon}</div><div class="name">${POWERUPS[id].name}</div>` : '');
      inv.appendChild(d);
    }
  }
  function renderEffects() {
    const e = [];
    if (P.chain > 0) e.push(`🔥 Mole chain x${P.chain}`);
    if (P.jelly > 0) e.push(`🟢 Jelly Belly × ${P.jelly}`);
    if (P.glide > 0) e.push(`☂️ Gliding ${P.glide.toFixed(1)}s`);
    if (P.rocket > 0) e.push(`🚀 Rocket!`);
    if (P.wing > 0) e.push(`🪂 Wingsuit ${P.wing.toFixed(0)}s`);
    if (P.icy > 0) e.push(`🧊 Icy Belly ${P.icy.toFixed(0)}s`);
    if (P.quack > 0) e.push(`🦆 Mud-proof ${P.quack.toFixed(0)}s`);
    if (P.sugar > 0) e.push(`🍰 Sugar rush ${P.sugar.toFixed(0)}s`);
    if (P.gnome) e.push(`🍄 Gnome's blessing (saves one splut)`);
    if (P.abduct > 0) e.push(`🛸 Being abducted…`);
    const html = e.map((t) => `<div class="effect">${t}</div>`).join('');
    if ($('effects').innerHTML !== html) $('effects').innerHTML = html;
  }
  function grantPowerup(reason, id = PU_KEYS[(Math.random() * PU_KEYS.length) | 0]) {
    if (P.inv.length >= MAX_SLOTS) { toast(`${reason}, but your slots are full!`, 'info'); return; }
    P.inv.push(id);
    P.stats.earned++;
    Sound.powerup();
    toast(`${reason} → ${POWERUPS[id].icon} ${POWERUPS[id].name}`);
    renderInventory();
  }

  // ------------------------------------------------------------------
  // Follow cam inset (bottom left, click to enlarge)
  // ------------------------------------------------------------------
  let pipBig = false;
  function pipRect() {
    const w = Math.round(innerWidth * (pipBig ? 0.5 : 0.24));
    return { x: 16, y: 16, w, h: Math.round((w * 9) / 16) };
  }
  function layoutPip() {
    const r = pipRect(), el = $('pip');
    el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
    el.classList.toggle('big', pipBig);
    const verb = TOUCH ? 'tap' : 'click';
    $('pipLabel').textContent = pipBig ? `Follow cam · ${verb} to shrink` : `Follow cam · ${verb} to enlarge`;
    chaseCam.aspect = r.w / r.h; chaseCam.updateProjectionMatrix();
  }
  $('pip').addEventListener('mousedown', (e) => { e.stopPropagation(); pipBig = !pipBig; layoutPip(); });
  layoutPip();

  const chaseLook = new THREE.Vector3();
  function updateChase(dt) {
    let tx, ty, tz, yaw = 0;
    if (phase === 'hitter') {
      tx = bike.root.position.x; ty = bike.root.position.y + 0.8; tz = bike.root.position.z;
    } else {
      tx = P.x; ty = P.y + 0.3; tz = P.z; yaw = P.yaw;
    }
    const fx = Math.sin(yaw), fz = -Math.cos(yaw);
    const wx = tx - fx * 7, wz = tz - fz * 7;
    let wy = ty + 2.6;
    if (wz > -1 && wy < CLIFF_H + 2) wy = CLIFF_H + 2; // don't end up inside the cliff
    const k = 1 - Math.exp(-6 * dt);
    chaseCam.position.set(wx, lerp(chaseCam.position.y, wy, k), wz);
    chaseLook.set(tx + fx * 4, ty, tz + fz * 4);
    chaseCam.lookAt(chaseLook);
  }

  // ------------------------------------------------------------------
  // Phase: hitter
  // ------------------------------------------------------------------
  function startRun() {
    Sound.init();
    phase = 'hitter';
    $('title').classList.add('hidden');
    $('results').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('pip').classList.remove('hidden');
    $('hitterHud').classList.remove('hidden');
    $('cyclistHud').classList.add('hidden');
    $('toasts').innerHTML = '';
    planEggs();
    resetWorld();
    Object.assign(P, {
      inv: [], jelly: 0, glide: 0, rocket: 0, airTime: 0, stopT: 0, squash: 0, vx: 0, chain: 0, splut: 0, moleT: 0, splutKind: null, flip: null, eggs: new Set(),
      icy: 0, quack: 0, sugar: 0, gnome: false, wing: 0, abduct: 0, bumped: false, prevY: 0,
      stats: { moles: 0, bestChain: 0, maxH: 0, maxAir: 0, bounces: 0, used: 0, earned: 0, hitQuality: '', launchSpeed: 0 },
    });
    B.active = false;
    bat.visible = true; fpArms.g.visible = false; fpMole.g.visible = false;
    $('splat').style.opacity = 0; $('blood').style.opacity = 0;
    rudeMole.g.visible = false; H.camYaw = BASE_LOOK; fpWings.visible = proneWings.visible = false;
    prone.root.visible = false;
    camera.layers.enable(LAYER_RIDER);
    camera.fov = 80; camera.updateProjectionMatrix();
    newApproach(0.6);
    renderInventory();
  }

  function newApproach(delay) {
    H.riding = false; H.spawnIn = delay; H.swingT = -1;
    H.baseSpeed = H.riderSpeed = rand(RIDER_SPEED_MIN, RIDER_SPEED_MAX);
    H.surgePhase = rand(0, 6.28); H.surgeRate = rand(0.7, 1.3);
    H.riderZ = RUNUP_Z;
    bike.root.position.set(LANE_X, CLIFF_H, H.riderZ);
    bike.root.rotation.set(0, 0, 0);
    bike.tumble.rotation.set(0, 0, 0);
    bike.rider.visible = true;
    bike.root.visible = false;
  }

  function swing() {
    if (phase !== 'hitter' || H.swingT >= 0) return;
    H.swingT = 0; H.contactChecked = false;
    Sound.swing();
  }

  const SWING_DUR = 0.26, CONTACT_FRAC = 0.5, RECOVER = 0.45;
  const BASE_LOOK = 3 * Math.PI / 4; // the batter stands at 45 degrees to the oncoming cyclist
  const yawTo = (x, z) => Math.atan2(-(x - HITTER_POS.x), -(z - HITTER_POS.z));

  function hitterCamera() {
    camera.position.set(HITTER_POS.x, CLIFF_H + 1.7, HITTER_POS.z);
  }

  function updateHitter(dt) {
    // Face 45 degrees toward the oncoming cyclist, then turn smoothly to follow them past.
    hitterCamera();
    const target = H.riding ? Math.min(BASE_LOOK, yawTo(LANE_X, H.riderZ)) : BASE_LOOK;
    H.camYaw += (target - H.camYaw) * (1 - Math.exp(-7 * dt));
    camera.rotation.set(-0.14, H.camYaw, 0);
    hitter.root.rotation.y = H.camYaw - Math.PI / 2;

    if (!H.riding) {
      H.spawnIn -= dt;
      if (H.spawnIn <= 0) { H.riding = true; bike.root.visible = true; }
      $('incoming').textContent = 'Here comes one…';
    } else {
      // gentle, uneven pedalling: the speed drifts a little as they ride in
      H.surgePhase += dt * H.surgeRate;
      H.riderSpeed = H.baseSpeed * (1 + RIDER_SURGE * (0.7 * Math.sin(H.surgePhase * 1.9) + 0.3 * Math.sin(H.surgePhase * 4.3 + 1)));
      H.riderZ -= H.riderSpeed * dt;
      bike.root.position.z = H.riderZ;
      spinWheels(H.riderSpeed, dt);
      // A missed cyclist just rides off the edge: slow and steep, so the odds are poor.
      if (H.riderZ <= 0.3) {
        bigText('Missed! Over the edge…', '#9fd4ff', 1.4);
        launch(0, true);
        return;
      }
      const d = H.riderZ - SWEET_Z;
      $('incoming').innerHTML = d < -HIT_WINDOW ? 'Heading for the edge…' :
        `Incoming: <b>${Math.round(H.riderSpeed * 3.6)} km/h</b>`;
    }
    animateBat(dt);
  }

  function animateBat(dt) {
    let k; // 0 = wound up, 1 = follow-through
    if (H.swingT < 0) k = 0;
    else {
      H.swingT += dt;
      const t = H.swingT;
      if (t < SWING_DUR) k = 1 - Math.pow(1 - t / SWING_DUR, 2);
      else if (t < SWING_DUR + RECOVER) k = 1 - (t - SWING_DUR) / RECOVER;
      else { k = 0; H.swingT = -1; }
      if (!H.contactChecked && t >= SWING_DUR * CONTACT_FRAC) { H.contactChecked = true; checkContact(); }
    }
    // first-person: from the left of the screen across to the right
    bat.rotation.y = lerp(Math.PI - 0.25, 0.35, k);
    bat.rotation.z = lerp(0.75, -0.15, k);
    bat.position.x = lerp(-0.3, -0.05, k);
    // third-person (follow cam)
    hitter.batPivot.rotation.y = lerp(-Math.PI / 2, -1.5 * Math.PI, k);
    hitter.batPivot.rotation.z = lerp(0.9, -0.1, k);
  }

  function checkContact() {
    if (phase !== 'hitter') return;
    if (!H.riding) { bigText('Too early!', '#9fd4ff', 0.9); return; }
    const dz = H.riderZ - SWEET_Z; // > 0: hasn't reached the midpoint yet = early
    if (Math.abs(dz) > HIT_WINDOW) { bigText(dz > 0 ? 'Too early!' : 'Too late!', '#9fd4ff', 0.9); return; }
    launch(dz / HIT_WINDOW);
  }

  const lookTarget = new THREE.Vector3();
  const tmpV = new THREE.Vector3();

  // t: +1 = as early as possible (steep and slow) .. 0 = perfect .. -1 = as late as possible (flat and fast)
  function launch(t, missed = false) {
    const perfect = !missed && Math.abs(t) < PERFECT_T;
    const angDeg = ANGLE_MID + ANGLE_SPAN * t;
    const ang = THREE.MathUtils.degToRad(angDeg);
    // The whack adds to the speed they already had, in the same direction.
    const whack = missed ? 0 : 16 + H.riderSpeed * 0.8;
    const sweet = 1 + 0.12 * Math.max(0, 1 - Math.abs(t) / 0.4); // small bonus near the middle
    const power = (H.riderSpeed + whack) * (1 - LATE_SPEED * t) * sweet;
    P.x = LANE_X; P.y = CLIFF_H + (missed ? 0.05 : 0.5); P.z = H.riderZ;
    if (missed) { P.h = H.riderSpeed * 0.45; P.vy = -1; }
    else { P.h = power * Math.cos(ang); P.vy = power * Math.sin(ang); }
    H.lastT = missed ? null : t;
    P.stats.launchAngle = missed ? null : angDeg;
    P.yaw = 0; P.vx = (Math.random() - 0.5) * Math.abs(t) * 4; P.chain = 0; P.splut = 0; P.moleT = 0; P.splutKind = null;
    P.onGround = false; P.airTime = 0; P.stopT = 0; P.pitch = 0; P.roll = 0; P.squash = 0; P.wobble = 0;
    P.stats.hitQuality = missed ? 'Missed' : perfect ? 'Perfect' : t > 0.5 ? 'Very early' : t > 0 ? 'Early' : t < -0.5 ? 'Very late' : 'Late';
    P.stats.launchSpeed = Math.hypot(P.h, P.vy);

    // The rider comes off; the bike carries on by itself.
    bike.rider.visible = false;
    bike.root.visible = true;
    Object.assign(B, {
      x: LANE_X, y: CLIFF_H, z: H.riderZ, active: true,
      vx: rand(-4, 4), vy: missed ? 0 : 3 + whack * 0.2, vz: -(missed ? H.riderSpeed * 0.8 : H.riderSpeed + whack * 0.45), spin: rand(5, 10),
    });
    prone.root.visible = true;
    placeProne();

    Sound.oof();
    if (!missed) {
      Sound.whack(); flash(); shake = 0.5;
      burst(P.x, CLIFF_H + 1, P.z, 5, 0xffffff, 3, 0.35);
      bigText(perfect ? 'PERFECT HIT!' : t > 0.5 ? 'EARLY: SKY HIGH!' : t < -0.5 ? 'LATE: FLAT & FAST!' : 'WHACK!', perfect ? '#ffd23f' : '#fff');
      toast(`Launch: ${angDeg.toFixed(1)}° at ${Math.round(power * 3.6)} km/h`, 'info');
    } else setTimeout(() => { if (phase !== 'launch' && phase !== 'rider') return; findEgg('sign'); grantPowerup('You were warned. Have a brolly', 'glide'); }, 1200);
    phase = 'launch';
    H.launchT = 0;
    timeScale = 0.3;
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    lookTarget.copy(camera.position).addScaledVector(dir, 8);
    if (perfect) setTimeout(() => grantPowerup('Perfect hit', 'rocket'), 900);
  }

  // Watch them go over the edge, then switch to the rider's view.
  function updateLaunch(dt, realDt) {
    H.launchT += realDt;
    if (H.launchT > 0.45) timeScale = lerp(timeScale, 1, 0.1);
    stepRider(dt);
    stepBike(dt);
    animateBat(dt);
    lookTarget.lerp(tmpV.set(P.x, P.y + 0.5, P.z), 0.12);
    hitterCamera();
    camera.lookAt(lookTarget);
    if (H.launchT > 1.5) {
      flash();
      phase = 'rider';
      timeScale = 1;
      bat.visible = false; fpArms.g.visible = true;
      camera.layers.disable(LAYER_RIDER);
      $('hitterHud').classList.add('hidden');
      $('cyclistHud').classList.remove('hidden');
      camera.rotation.set(0, -P.yaw, 0);
    }
  }

  function spinWheels(speed, dt) {
    for (const w of bike.wheels) w.rotation.x -= (speed / 0.34) * dt;
    bike.crank.rotation.x -= (speed / 1.2) * dt;
  }

  // Riderless bike: tumbles, bounces, and comes to rest.
  function stepBike(dt) {
    if (!B.active) return;
    B.vy -= GRAVITY * dt;
    B.x += B.vx * dt; B.y += B.vy * dt; B.z += B.vz * dt;
    const gy = groundAt(B.z);
    if (B.y <= gy) {
      B.y = gy;
      if (B.vy < -2) {
        B.vy *= -0.35; B.vx *= 0.7; B.vz *= 0.7; B.spin *= 0.6;
        Sound.clatter();
        burst(B.x, gy + 0.2, B.z, 4, 0xb89a6a, 2);
      } else {
        B.vy = 0;
        const f = Math.max(0, 1 - 3 * dt);
        B.vx *= f; B.vz *= f;
        if (Math.hypot(B.vx, B.vz) < 0.3) {
          B.active = false;
          bike.tumble.rotation.set(0, rand(-1, 1), Math.PI / 2); // lying on its side
          bike.root.position.set(B.x, gy - 0.4, B.z);
          return;
        }
      }
    }
    bike.tumble.rotation.x -= B.spin * dt;
    bike.root.position.set(B.x, B.y, B.z);
    spinWheels(Math.hypot(B.vx, B.vz) + 3, dt);
  }

  // ------------------------------------------------------------------
  // Rider physics (belly bouncing)
  // ------------------------------------------------------------------
  // Molehills: a big launch, and each one hit in a row (without touching flat ground) is stronger.
  function checkMolehills() {
    for (const o of objects) {
      if (o.type !== 'mole' || o.used) continue;
      const ddz = P.z - o.z;
      if (Math.abs(ddz) > 3 || P.y > 0.7 || Math.hypot(P.x - o.x, ddz) > o.r) continue;
      o.used = true;
      if (phase === 'rider' && isSplutLanding()) { splutEnd('mole', o); return; }
      P.chain++;
      let mult = 1 + 0.5 * (P.chain - 1);
      if (P.sugar > 0) mult *= 1.5;
      if (o.golden) { mult *= 2.5; findEgg('golden'); bigText('GOLDEN MOLEHILL!', '#ffd700', 1.2); }
      P.vy = Math.min(55, (10 + P.h * 0.2) * mult);
      P.h = Math.min(90, P.h * 1.08 + 5 * mult);
      P.y = Math.max(P.y, 0.3);
      P.onGround = false;
      P.wobble = 1;
      shake = Math.min(0.8, 0.25 + 0.1 * P.chain);
      o.mesh.scale.y = 0.35;
      if (o.mole) { o.mole.position.y = 0.9; o.mole.scale.setScalar(1.4); }
      P.stats.moles++;
      P.stats.bestChain = Math.max(P.stats.bestChain, P.chain);
      Sound.boing(P.chain);
      burst(o.x, 0.3, o.z, 10 + P.chain * 3, 0x6b4423, 4 + P.chain);
      if (P.chain >= 2) bigText(`MOLE CHAIN x${P.chain}!`, '#ffb347', 0.9);
      if (P.chain === 5) grantPowerup('5-molehill chain');
      return;
    }
  }

  // Too steep a landing (and no Jelly Belly to save you)?
  function splutDanger(vy = P.vy) {
    if (vy >= 0) return 0;
    const angle = Math.atan2(-vy, Math.max(P.h, 0.1)) / (Math.PI / 2); // 0 flat .. 1 straight down
    return (-vy * (SPLUT_FLAT + SPLUT_STEEP * angle)) / SPLUT_LIMIT;  // >= 1 means splut
  }
  function isSplutLanding() {
    return P.jelly <= 0 && splutDanger() >= 1;
  }

  // A splut always ends the run. kind: 'dirt' | 'mole' | 'rock'
  function splutEnd(kind, o) {
    if (P.gnome) {
      P.gnome = false;
      P.vy = 9; P.onGround = false; P.h = Math.max(P.h, 6);
      P.y = kind === 'rock' || kind === 'rocktop' ? o.top + 0.1 : groundAt(P.z) + 0.05;
      if (o) o.used = true;
      Sound.boing(); burst(P.x, P.y, P.z, 12, 0xd32f2f, 4);
      bigText("SAVED BY THE GNOME!", '#ff8a80', 1.2);
      return;
    }
    P.splutKind = kind;
    P.splut = kind === 'mole' ? MOLE_T : SPLUT_TIME;
    P.h = 0; P.vy = 0; P.vx = 0; P.onGround = true; P.chain = 0;
    P.squash = 1; P.wobble = 0; shake = 0.9;
    P.y = groundAt(P.z);
    Sound.splat();
    if (kind === 'mole') {
      P.moleT = MOLE_T; P.y = 0.25;
      o.mesh.scale.y = 0.5;
      if (o.mole) o.mole.visible = false; // it's in your face now
      Sound.sniff();
      burst(o.x, 0.4, o.z, 18, 0x6b4423, 4, 1.0);
      bigText('SPLUT! Into a molehill…', '#c0703a', 1.6);
    } else if (kind === 'rocktop') {
      P.y = o.top;
      Sound.thud(1);
      burst(P.x, o.top, P.z, 14, 0xaa1111, 4, 0.9);
      bigText('PANCAKED ON A BOULDER!', '#e04040', 1.6);
    } else if (kind === 'rock') {
      P.z = o.z + o.r; // stopped at the face of the rock
      Sound.thud(1);
      burst(P.x, 0.8, P.z - 0.4, 12, 0x8a8a90, 4, 0.8);
      burst(P.x, 0.8, P.z - 0.4, 10, 0xaa1111, 3, 0.8);
      bigText('SPLUT! Into a rock!', '#e04040', 1.4);
    } else {
      burst(P.x, 0.2, P.z - 0.5, 18, 0x8a6440, 5, 1.0);
      bigText('SPLUT!', '#c0703a', 1.4);
    }
    placeProne();
  }

  function stepRider(dt) {
    const s = P.stats;

    P.prevY = P.y;
    // stuck head-first after a splut, until the results show
    if (P.splutKind) {
      P.splut = Math.max(0, P.splut - dt);
      placeProne();
      return;
    }

    // Steering: direct sideways speed. It scales with forward speed, so any molehill in the
    // play area you can see coming is reachable, in the air or on the ground.
    let steerIn = 0;
    if (phase === 'rider') {
      if (keys.KeyA || keys.ArrowLeft || touchL) steerIn -= 1;
      if (keys.KeyD || keys.ArrowRight || touchR) steerIn += 1;
    }
    P.steer = lerp(P.steer, steerIn, 0.2);
    const latMax = Math.max(STEER_SPEED, P.h * 0.4);
    P.vx = lerp(P.vx, steerIn * latMax, 1 - Math.exp(-5 * dt));
    P.yaw = Math.atan2(P.vx, Math.max(P.h, 4)) * 0.7; // where the camera looks

    // timers
    if (P.glide > 0) P.glide -= dt;
    for (const k of ['icy', 'quack', 'sugar']) if (P[k] > 0) P[k] = Math.max(0, P[k] - dt);
    if (P.wing > 0) { P.wing = Math.max(0, P.wing - dt); if (P.wing === 0) toast('Wingsuit used up', 'info'); }
    if (P.abduct > 0) {
      // beamed up by the UFO, then flung back out
      P.abduct -= dt; P.vy = 11; P.onGround = false; P.h *= 1 - 0.6 * dt;
      if (P.abduct <= 0) { P.h += 16; P.vy = 4; toast('The aliens threw you back!', 'egg'); Sound.zap(); }
    }
    if (P.rocket > 0) {
      P.rocket -= dt;
      P.vy += 14 * dt; P.h += 6 * dt;
      if (Math.random() < 0.6) burst(P.x - Math.sin(P.yaw) * 1.5, P.y + 0.3, P.z + Math.cos(P.yaw) * 1.5, 1, Math.random() < 0.5 ? 0xff8a1c : 0xffd23f, 2, 0.5);
    }

    // gravity + drag
    const g = GRAVITY * (P.wing > 0 ? 0.15 : P.glide > 0 ? 0.28 : 1);
    P.vy -= g * dt;
    if (P.glide > 0 && P.vy < -2.5) P.vy = lerp(P.vy, -2.5, 0.2);
    if (P.wing > 0) { if (P.vy < -1.6) P.vy = lerp(P.vy, -1.6, 0.15); P.h = Math.max(P.h, 18); }
    const sp = Math.hypot(P.h, P.vy);
    if (sp > 0.01 && !P.onGround) {
      const drag = AIR_DRAG * sp * sp * (P.wing > 0 ? 0.35 : P.glide > 0 ? 0.5 : 1);
      P.h -= drag * (P.h / sp) * dt;
      P.vy -= drag * (P.vy / sp) * dt;
    }

    // move
    P.x += P.vx * dt; P.z -= P.h * dt; P.y += P.vy * dt;
    if (Math.abs(P.x) > PLAY_X) { P.x = Math.sign(P.x) * PLAY_X; P.vx = 0; }

    // molehills are checked before the ground so a landing on one counts
    checkMolehills();
    for (const o of objects) {
      if (o.type !== 'rock' || o.used || P.vy >= 0 || P.prevY < o.top - 0.15 || P.y >= o.top) continue;
      if (Math.hypot(P.x - o.x, P.z - o.z) > o.r * 0.9) continue;
      o.used = true;
      if (P.jelly > 0) { P.y = o.top; P.vy = Math.max(-P.vy * 0.8, 8); Sound.boing(); toast('Jelly belly bounced off a boulder!', 'info'); continue; }
      splutEnd('rocktop', o); return;
    }

    // ground: belly flop bounces
    const gy = groundAt(P.z);
    if (P.y <= gy) {
      P.y = gy;
      P.airTime = 0;
      if (P.wing > 0) { P.wing = 0; toast('Wingsuit off: you touched down', 'info'); }
      if (isSplutLanding()) {
        splutEnd('dirt');
        return;
      } else if (P.vy < -2) {
        const impact = -P.vy;
        const jelly = P.jelly > 0;
        P.vy = impact * (jelly ? 0.88 : RESTITUTION);
        P.h *= jelly ? 1.0 : P.icy > 0 ? 0.95 : 0.8;
        P.squash = clamp(impact / 15, 0.3, 1);
        P.wobble = 1;
        if (jelly) { P.jelly--; Sound.boing(); burst(P.x, gy + 0.2, P.z, 8, 0x55dd66, 4); }
        else {
          Sound.thud(clamp(impact / 20, 0.3, 1));
          if (impact > 6) Sound.oof();
          burst(P.x, gy + 0.2, P.z, 10, 0xb89a6a, 3 + impact * 0.1);
        }
        shake = Math.min(0.7, impact * 0.03);
        s.bounces++;
        P.onGround = false;
      } else {
        P.vy = 0;
        P.onGround = true;
      }
      if (P.chain > 1) toast(`Chain ended at x${P.chain}`, 'info');
      P.chain = 0;
    } else if (P.y > gy + 0.05) {
      P.onGround = false;
    }

    if (P.onGround) {
      P.h = Math.max(0, P.h - (SLIDE_FRICTION * dt + SLIDE_DRAG * P.h * P.h * dt) * (P.icy > 0 ? 0.25 : 1));
      P.airTime = 0;
      if (P.h > 3 && Math.random() < 0.5) burst(P.x, gy + 0.05, P.z, 1, 0xb89a6a, 1.5, 0.6);
    } else {
      P.airTime += dt;
    }
    P.squash = Math.max(0, P.squash - dt * 4);
    P.wobble = Math.max(0, P.wobble - dt * 1.5);

    // interactions
    for (const o of objects) {
      const ddx = P.x - o.x, ddz = P.z - o.z;
      if (Math.abs(ddz) > (o.reach || 4)) continue;
      const d = Math.hypot(ddx, ddz);
      switch (o.type) {
        case 'egg':
          if (!o.found && d < o.hitR && P.y < o.hitH && P.abduct <= 0) { o.found = true; findEgg(o.id); applyEgg(o); }
          break;
        case 'wing':
          if (!o.used && Math.hypot(d, P.y + 0.3 - o.y) < 4.5) {
            o.used = true; o.pick.visible = false;
            P.wing = WINGSUIT_TIME; P.glide = 0;
            if (!Sound.play('sparkle', 0.8)) Sound.powerup();
            bigText('WINGSUIT!', '#82b1ff', 1.2);
            toast('🪂 Wingsuit: glide for 20 s (ends if you touch the ground)', 'info');
          }
          break;
        case 'mud':
          if (P.y < 0.2 && P.quack <= 0 && inMud(o, P.x, P.z)) {
            P.h = Math.max(0, P.h - o.slow * dt);
            if (Math.random() < 0.3) burst(P.x, 0.1, P.z, 1, o.mesh.material.color.getHex(), 2, 0.5);
            if (!o.used) { o.used = true; Sound.splash(); toast(`${o.name}! Slowing down…`, 'bad'); }
          }
          break;
        case 'boost':
          if (!o.used && Math.abs(ddx) < 1.4 && Math.abs(ddz) < 2.1 && P.y < 0.5) {
            o.used = true; P.h += 12; Sound.zap(); toast('Speed boost! +43 km/h', 'info');
          }
          break;
        case 'rock':
          if (!o.used && d < o.r && P.y < o.top) {
            o.used = true;
            if (P.jelly > 0) {
              P.vy = Math.max(P.vy, 10); P.y = Math.max(P.y, o.top * 0.6); P.onGround = false;
              Sound.boing(); toast('Jelly belly bounced off a rock!', 'info');
              burst(o.x, 0.6, o.z, 8, 0x8a8a90, 4);
            } else if (Math.hypot(P.h, P.vy) < ROCK_SPLAT_SPEED) {
              // a gentle bump: you just stop against it
              P.z = Math.max(P.z, o.z + o.r); P.h = 0; P.vx = 0; P.bumped = true;
              Sound.thud(0.5); toast('Bumped into a rock', 'info');
            } else { splutEnd('rock', o); return; }
          }
          break;
        case 'qbox':
          if (!o.used && Math.hypot(d, P.y + 0.2 - o.y) < 1.9) {
            o.used = true; o.gone = true; o.mesh.visible = false;
            Sound.pop(); burst(o.x, o.y, o.z, 12, 0xffc93c, 5);
            grantPowerup('Picked up');
          }
          break;
      }
    }

    // stats
    s.maxH = Math.max(s.maxH, P.y);
    s.maxAir = Math.max(s.maxAir, P.airTime);

    placeProne();
  }

  // Pose the third-person rider: belly down, squashing on impact, arms flailing in the air.
  function placeProne() {
    if (P.splutKind) {
      // head buried, legs kicking
      const t = performance.now() / 1000;
      prone.root.position.set(P.x, P.y + 0.3, P.z);
      prone.root.rotation.set(-1.2, -P.yaw, Math.sin(t * 6) * 0.05);
      prone.body.scale.set(1, 1, 1);
      prone.legs.forEach((l, i) => { l.rotation.x = Math.sin(t * 25 + i * 3) * 0.5; });
      prone.arms.forEach((a, i) => { a.rotation.x = 0.4; a.rotation.z = (i ? 1 : -1) * 0.6; });
      return;
    }
    prone.root.position.set(P.x, P.y, P.z);
    const airPitch = P.onGround ? 0 : clamp(Math.atan2(P.vy, Math.max(P.h, 2)) * 0.6, -0.6, 0.5);
    const t = performance.now() / 1000;
    prone.root.rotation.set(airPitch + Math.sin(t * 14) * 0.2 * P.wobble, -P.yaw, Math.sin(t * 9) * 0.15 * P.wobble);
    prone.body.scale.set(1 + P.squash * 0.25, 1 - P.squash * 0.45, 1 + P.squash * 0.1);
    const flail = P.onGround ? 0.1 : 1;
    prone.arms.forEach((a, i) => { a.rotation.x = Math.sin(t * 11 + i * 2) * 0.5 * flail; a.rotation.z = Math.sin(t * 8 + i) * 0.3 * flail; });
    prone.legs.forEach((l, i) => { l.rotation.x = Math.sin(t * 10 + i * 3) * 0.4 * flail; });
  }

  function usePowerup(slot) {
    if (phase !== 'rider' || slot >= P.inv.length || P.splutKind) return;
    const id = P.inv.splice(slot, 1)[0];
    P.stats.used++;
    P.stopT = 0;
    switch (id) {
      case 'rocket':
        P.rocket = ROCKET_TIME; P.vy = Math.max(P.vy, 0) + 4; P.h += 2; P.onGround = false; P.y = Math.max(P.y, 0.1);
        Sound.rocket(); bigText('ROCKET!', '#ff8a1c', 0.8); shake = 0.4; break;
      case 'jelly':
        P.jelly = 4; Sound.boing(); bigText('JELLY BELLY!', '#55dd66', 0.8); break;
      case 'glide':
        P.glide = 5; if (P.onGround) { P.vy = 6; P.onGround = false; }
        Sound.powerup(); bigText('GLIDE!', '#c9a0ff', 0.8); break;
      case 'mole': {
        const dx = Math.sin(P.yaw), dz = -Math.cos(P.yaw);
        const ahead = Math.max(8, P.h * 0.6);
        for (let k = 0; k < 4; k++) {
          const d = ahead + k * Math.max(8, P.h * 0.9);
          const o = makeMolehill(clamp(P.x + P.vx * (d / Math.max(P.h, 1)), -PLAY_X + 1, PLAY_X - 1), P.z - d);
          o.chunk = Math.max(0, Math.floor(-o.z / CHUNK));
          const c = chunks.get(o.chunk);
          (c ? c.group : scene).add(o.mesh);
          objects.push(o);
          burst(o.x, 0.3, o.z, 6, 0x6b4423, 3);
        }
        Sound.boing(); bigText('MOLE CALL!', '#d8a060', 0.8); break;
      }
    }
    renderInventory();
  }

  function maybeFlip() {
    let best = null, bd = FLIP_RANGE;
    for (const o of objects) {
      if (o.type !== 'mole') continue;
      const d = Math.hypot(o.x - P.x, o.z - P.z);
      if (d < bd) { bd = d; best = o; }
    }
    if (!best) return;
    P.flip = { o: best, t: 0 };
    if (best.mole) best.mole.visible = false;
    rudeMole.g.visible = true;
    rudeMole.g.position.set(best.x, -0.9, best.z);
    rudeMole.g.rotation.y = Math.atan2(P.x - best.x, P.z - best.z);
    const dir = new THREE.Vector3(); camera.getWorldDirection(dir);
    flipLook.copy(camera.position).addScaledVector(dir, 5);
    Sound.boing();
  }
  function cancelFlip() {
    if (!P.flip) return;
    if (P.flip.o.mole) P.flip.o.mole.visible = true;
    P.flip = null; rudeMole.g.visible = false;
  }
  function animateFlip(dt) {
    const f = P.flip; f.t += dt;
    const t = f.t, rise = clamp(t / 0.4, 0, 1), up = clamp((t - 0.55) / 0.25, 0, 1);
    rudeMole.g.position.y = lerp(-0.9, 0.05, 1 - Math.pow(1 - rise, 3));
    rudeMole.arm.rotation.x = lerp(Math.PI * 0.85, -0.1, up) + (up >= 1 ? Math.sin(t * 16) * 0.12 : 0);
    rudeMole.head.rotation.z = Math.sin(t * 7) * 0.12;
    if (up >= 1 && !f.said) { f.said = true; toast('The mole would like a word.', 'bad'); Sound.sniff(); }
    // turn to look at it, and zoom in a little
    flipLook.lerp(tmpV.set(f.o.x, 1.1, f.o.z), 1 - Math.exp(-5 * dt));
    camera.lookAt(flipLook);
    camera.fov = lerp(camera.fov, 45, 1 - Math.exp(-3 * dt)); camera.updateProjectionMatrix();
  }

  function updateRider(dt) {
    stepRider(dt);
    stepBike(dt);

    // first-person camera at the rider's head, low to the ground
    const fx = Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    const targetPitch = P.splutKind === 'mole' ? -0.15 : P.splutKind === 'rock' ? 0 : P.splutKind ? -0.9 : P.onGround ? 0.02 : clamp(Math.atan2(P.vy, Math.max(P.h, 2)) * 0.55, -0.55, 0.4);
    P.pitch = lerp(P.pitch, targetPitch, 0.08);
    const t = performance.now() / 1000;
    P.roll = lerp(P.roll, -P.steer * 0.1 + Math.sin(t * 9) * 0.08 * P.wobble, 0.15);
    camera.position.set(P.x + fx * 0.55, P.splutKind === 'dirt' ? P.y + 0.15 : P.splutKind ? P.y + 0.3 : P.y + 0.42 - P.squash * 0.18, P.z + fz * 0.55);
    $('splat').style.opacity = P.splutKind === 'mole' ? 0.35 : P.splutKind === 'dirt' ? 1 : 0;
    $('blood').style.opacity = P.splutKind === 'rock' || P.splutKind === 'rocktop' ? 1 : 0;
    camera.rotation.set(P.pitch + Math.sin(t * 14) * 0.05 * P.wobble, -P.yaw, P.roll);
    const fov = P.flip ? camera.fov : 74 + Math.min(P.h, 50) * 0.36;
    if (Math.abs(camera.fov - fov) > 0.1) { camera.fov = lerp(camera.fov, fov, 0.1); camera.updateProjectionMatrix(); }

    // first-person arms: flail in the air, reach forward when sliding
    const flail = P.onGround ? 0.08 : 1;
    fpArms.arms.forEach((a, i) => {
      a.rotation.x = Math.sin(t * 11 + i * 2) * 0.25 * flail;
      a.rotation.z = Math.sin(t * 8 + i) * 0.2 * flail - P.steer * 0.15;
      a.position.y = -0.32 - P.squash * 0.08;
    });

    // splutted into a molehill: the mole whiffles up at you
    if (P.moleT > 0) {
      P.moleT = Math.max(0, P.moleT - dt);
      const t2 = MOLE_T - P.moleT;
      const rise = t2 < 0.3 ? 1 - Math.pow(1 - t2 / 0.3, 3) : 1;
      fpMole.g.visible = true;
      fpMole.g.position.set(Math.sin(t2 * 5) * 0.05, lerp(-0.95, -0.2, rise), -0.75);
      fpMole.g.rotation.set(0.25 + Math.sin(t2 * 23) * 0.08, Math.sin(t2 * 7) * 0.25, Math.sin(t2 * 17) * 0.1);
      fpMole.nose.scale.setScalar(1 + 0.35 * Math.abs(Math.sin(t2 * 40)));
      fpMole.whiskers.forEach((w, i) => { w.rotation.z = w.userData.base + Math.sin(t2 * 45 + i) * 0.15; });
    } else fpMole.g.visible = false;

    fpWings.visible = proneWings.visible = P.wing > 0;
    $('rocketGlow').style.opacity = P.rocket > 0 ? 1 : 0;
    renderEffects();
    Sound.setWind(Math.hypot(P.h, P.vy) / 60);

    // end of run
    if (P.splutKind) {
      if (P.splut <= 0) endRun(P.splutKind);
    } else if (P.onGround && P.h < 0.5) {
      P.h = 0;
      if (P.stopT === 0) maybeFlip();
      P.stopT += dt;
      if (P.inv.length && P.stopT < 0.05) toast('Stopped! Use a powerup to keep going…', 'info');
      if (P.flip) animateFlip(dt);
      if (P.stopT > (P.flip ? 3.2 : P.inv.length ? 3 : 1.2)) endRun();
    } else { P.stopT = 0; cancelFlip(); }
  }

  function endRun(splutKind = null) {
    phase = 'results';
    Sound.setWind(0);
    $('rocketGlow').style.opacity = 0;
    $('pip').classList.add('hidden');
    const dist = Math.max(0, -P.z);
    const NOTES = { dirt: 'Head-first into the dirt.', mole: 'Head-first into a molehill. The mole was not impressed.', rock: 'Head-first into a rock. Ouch.', rocktop: 'Belly-flopped onto the top of a boulder. The boulder won.' };
    $('resTitle').textContent = splutKind === 'rocktop' ? 'PANCAKED!' : splutKind ? 'SPLUT!' : 'Run over!';
    $('resNote').textContent = NOTES[splutKind] || '';
    $('resNote').classList.toggle('hidden', !splutKind);
    const isBest = dist > best;
    if (isBest) { best = dist; localStorage.setItem('pedalPanicBest', String(best)); }
    $('resDist').textContent = dist.toFixed(1) + ' m';
    $('resNew').classList.toggle('hidden', !isBest);
    const s = P.stats;
    const stat = (label, v) => `<div><span class="label">${label}</span>${v}</div>`;
    $('resStats').innerHTML = [
      stat('Hit', s.hitQuality),
      stat('Launch angle', s.launchAngle == null ? 'n/a' : s.launchAngle.toFixed(1) + '°'),
      stat('Ended by', splutKind === 'rocktop' ? 'Pancaked' : splutKind ? 'Splut' : P.flip ? 'Rude mole' : P.bumped ? 'Bumped a rock' : 'Sliding to a stop'),
      stat('Molehills', s.moles),
      stat('Best mole chain', 'x' + s.bestChain),
      stat('Easter eggs', `${P.eggs.size} (all-time ${allEggs.size}/${EGGS.length})`),
    ].join('');
    $('results').classList.remove('hidden');
    $('hud').classList.add('hidden');
  }

  // ------------------------------------------------------------------
  // HUD top bar
  // ------------------------------------------------------------------
  // Analogue dial (SVG): 240-degree sweep, needle eases toward the value
  function makeDial(id, max, step, unit, redFrom) {
    const el = $(id), NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 100 100');
    const ang = (v) => (-210 + 240 * v / max) * Math.PI / 180;
    const pt = (v, r) => [50 + r * Math.cos(ang(v)), 50 + r * Math.sin(ang(v))];
    const add = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.appendChild(e); return e; };
    add('circle', { cx: 50, cy: 50, r: 47, class: 'dial-face' });
    if (redFrom != null) {
      const [x1, y1] = pt(redFrom, 40), [x2, y2] = pt(max, 40);
      add('path', { d: `M${x1} ${y1} A40 40 0 0 1 ${x2} ${y2}`, class: 'dial-red' });
    }
    for (let v = 0; v <= max + 1e-6; v += step / 2) {
      const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
      const [x1, y1] = pt(v, major ? 34 : 38), [x2, y2] = pt(v, 43);
      add('line', { x1, y1, x2, y2, class: major ? 'dial-major' : 'dial-minor' });
      if (major) { const [tx, ty] = pt(v, 25); const t = add('text', { x: tx, y: ty + 3, class: 'dial-num' }); t.textContent = v; }
    }
    const needle = add('line', { x1: 50, y1: 50, x2: 50, y2: 12, class: 'dial-needle' });
    add('circle', { cx: 50, cy: 50, r: 4, class: 'dial-hub' });
    const read = add('text', { x: 50, y: 80, class: 'dial-read' });
    const u = add('text', { x: 50, y: 91, class: 'dial-unit' }); u.textContent = unit;
    el.appendChild(svg);
    let shown = 0;
    return {
      set(v) {
        shown += (v - shown) * 0.25;
        const a = -120 + 240 * clamp(shown / max, 0, 1.03);
        needle.setAttribute('transform', `rotate(${a} 50 50)`);
        read.textContent = Math.round(v);
      },
    };
  }
  const speedDial = makeDial('dialSpeed', 250, 50, 'km/h', 200);
  const heightDial = makeDial('dialHeight', 100, 20, 'm high', null);

  function updateTopBar() {
    const flying = phase === 'launch' || phase === 'rider';
    $('hDist').textContent = (flying ? Math.max(0, -P.z) : 0).toFixed(0) + ' m';
    speedDial.set(flying ? P.h * 3.6 : 0);
    heightDial.set(flying ? Math.max(0, P.y - groundAt(P.z)) : 0);
    $('hMoles').textContent = P.stats ? P.stats.moles : 0;
    $('hBest').textContent = best.toFixed(0) + ' m';
  }

  // ------------------------------------------------------------------
  // Input
  // ------------------------------------------------------------------
  addEventListener('mousemove', (e) => {
    mouse.x = (e.clientX / innerWidth) * 2 - 1;
    mouse.y = (e.clientY / innerHeight) * 2 - 1;
  });
  renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 0) swing(); });
  addEventListener('keydown', (e) => {
    keys[e.code] = true;
    if (e.code === 'Space') { e.preventDefault(); if (phase === 'hitter') swing(); else usePowerup(0); }
    if (e.code === 'Digit1') usePowerup(0);
    if (e.code === 'Digit2') usePowerup(1);
    if (e.code === 'Digit3') usePowerup(2);
    if (e.code === 'KeyR' && phase === 'results') startRun();
    if (e.code === 'Enter' && (phase === 'title' || phase === 'results')) startRun();
  });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  // Touch: hold the left or right half of the screen to steer, tap anywhere to swing,
  // tap a powerup slot to use it, tap the follow cam to resize it.
  let touchL = false, touchR = false;
  const onUi = (el) => el && el.closest && el.closest('button, .screen, #rotate');
  function readTouches(e) {
    let l = false, r = false;
    for (const t of e.touches) {
      if (onUi(t.target) || t.target.closest('#pip, .slot')) continue;
      if (t.clientX < innerWidth / 2) l = true; else r = true;
    }
    touchL = l; touchR = r;
    $('touchL').classList.toggle('on', l);
    $('touchR').classList.toggle('on', r);
  }
  if (TOUCH) {
    addEventListener('touchstart', (e) => {
      if (onUi(e.target)) return; // let buttons and menus behave normally
      e.preventDefault();         // no zoom, scroll or fake mouse clicks
      for (const t of e.changedTouches) {
        const slot = t.target.closest('.slot');
        if (slot) { usePowerup(+slot.dataset.slot); continue; }
        if (t.target.closest('#pip')) { pipBig = !pipBig; layoutPip(); continue; }
        if (phase === 'hitter') swing();
      }
      readTouches(e);
    }, { passive: false });
    addEventListener('touchmove', (e) => { if (!onUi(e.target)) e.preventDefault(); readTouches(e); }, { passive: false });
    addEventListener('touchend', readTouches);
    addEventListener('touchcancel', readTouches);
  }
  // On phones, go fullscreen and lock to landscape where the browser allows it (Android Chrome does; iPhone doesn't).
  function goFullscreen() {
    if (!TOUCH || document.fullscreenElement) return;
    const el = document.documentElement;
    if (!el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'))
      .catch(() => {});
  }
  $('startBtn').addEventListener('click', () => { goFullscreen(); startRun(); Sound.button(); });
  $('againBtn').addEventListener('click', () => { goFullscreen(); startRun(); Sound.button(); });

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------
  buildCliff();
  resetWorld();
  newApproach(0);
  bike.root.visible = true;
  fpArms.g.visible = false;

  const clock = new THREE.Clock();
  let titleT = 0;
  function frame() {
    // Paused while a phone is held upright (the "turn sideways" screen is showing).
    if (isPortrait()) { clock.getDelta(); requestAnimationFrame(frame); return; }
    const realDt = Math.min(clock.getDelta(), 1 / 30);
    const dt = realDt * timeScale;

    if (phase === 'title') {
      titleT += realDt;
      camera.position.set(Math.sin(titleT * 0.2) * 3, CLIFF_H + 6, 30 - titleT * 5);
      camera.rotation.set(-0.15, Math.sin(titleT * 0.1) * 0.2, 0);
      updateChunks(Math.min(0, camera.position.z));
    } else if (phase === 'hitter') {
      updateHitter(dt);
    } else if (phase === 'launch') {
      updateLaunch(dt, realDt);
      updateChunks(P.z);
    } else if (phase === 'rider') {
      updateRider(dt);
      updateChunks(P.z);
    }
    if (phase === 'hitter' || phase === 'launch' || phase === 'rider') updateChase(realDt);

    // Height haze: fog closes in as you climb so everything below fades into the sky, and clears as you drop.
    const camAlt = camera.position.y - groundAt(camera.position.z);
    const hz = phase === 'rider' ? clamp((camAlt - HAZE_START) / (HAZE_FULL - HAZE_START), 0, 1) : 0;
    haze += (hz - haze) * (1 - Math.exp(-4 * realDt));
    const k = haze * haze * (3 - 2 * haze);
    // the clear oval shrinks from huge (no effect) to nothing as you climb
    const rad = 350 * Math.pow(1 - k, 2) + 1;
    HAZE_U.hazeOn.value = k > 0.002 ? 1 : 0;
    HAZE_U.hazeCenter.value.set(P.x, P.z);
    HAZE_U.hazeFwd.value.set(Math.sin(P.yaw), -Math.cos(P.yaw));
    HAZE_U.hazeRadii.value.set(rad * HAZE_AHEAD, rad * HAZE_BEHIND, rad * HAZE_SIDE);
    for (const o of objects) if (o.type !== 'wing') o.mesh.visible = !o.gone;
    const nowS = performance.now() / 1000;
    for (const o of objects) {
      if (o.type === 'qbox') { o.mesh.rotation.y += realDt * 1.5; o.mesh.position.y = o.y + Math.sin(nowS * 2.5 + o.x) * 0.3; }
      else if (o.update) o.update(nowS);
      else if (o.type === 'wing') { o.pick.rotation.y += realDt * 2; o.pick.position.y = Math.sin(nowS * 2) * 0.3; }
    }

    if (shake > 0) {
      shake = Math.max(0, shake - realDt * 1.5);
      camera.position.x += rand(-1, 1) * shake * 0.15;
      camera.position.y += rand(-1, 1) * shake * 0.15;
    }
    updateParticles(realDt);
    updateTopBar();
    posePeople();

    // main view, then the follow cam inset
    const following = phase === 'rider' || phase === 'launch';
    const fx = following ? P.x : camera.position.x, fz = following ? P.z : camera.position.z;
    placeSun(fx, following ? groundAt(fz) : CLIFF_H, fz);
    renderer.shadowMap.needsUpdate = true;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.render(scene, camera);
    if (!$('pip').classList.contains('hidden')) {
      const r = pipRect();
      renderer.setScissorTest(true);
      renderer.setScissor(r.x, r.y, r.w, r.h);
      renderer.setViewport(r.x, r.y, r.w, r.h);
      renderer.render(scene, chaseCam);
      renderer.setScissorTest(false);
    }
    requestAnimationFrame(frame);
  }
  frame();

  // Small hook for automated testing.
  window.__game = { get phase() { return phase; }, P, H, B, startRun, launch, usePowerup, grantPowerup, keys,
    people, bikeObj: bike, hitterObj: hitter, proneObj: prone, scene, renderer, posePeople, togglePip: () => { pipBig = !pipBig; layoutPip(); },
    eggFx: applyEgg, rocks: () => objects.filter((o) => o.type === 'rock'),
    soundsLoaded: () => Object.keys(Sound.buffers), eggPlan: () => eggPlan, objects: () => objects, findEgg,
    rockAhead: (d = 3) => { const r = new THREE.Mesh(G.rock, M.rock); r.scale.setScalar(2); r.position.set(P.x, 0.9, P.z - d); scene.add(r); objects.push({ type: 'rock', x: P.x, z: P.z - d, r: 1.6, top: 2.1, mesh: r, chunk: Math.max(0, Math.floor((d - P.z) / CHUNK)), used: false }); },
    moleAhead: (d = 3) => { const o = makeMolehill(P.x, P.z - d); o.chunk = Math.max(0, Math.floor(-o.z / CHUNK)); scene.add(o.mesh); objects.push(o); } };
})();
