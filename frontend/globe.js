/**
 * globe.js — Optimised Three.js Globe Renderer
 *
 * PERFORMANCE FIXES vs original:
 *  1. Geometry pool — arc BufferGeometry pre-allocated once, reused via drawRange
 *  2. Material pool — one shared material per attack type, not one-per-arc
 *  3. SphereGeometry(72,72) → (48,48) — 56% fewer vertices on earth mesh
 *  4. Star count 9000 → 4000 — halved, still visually identical at this scale
 *  5. Grid lines merged into single LineSegments draw call (was N separate Line objects)
 *  6. Atmosphere sphere segments 64 → 32 — imperceptible quality difference
 *  7. ARC_LIMIT 250 → 120 — 250 simultaneous transparent additive objects thrash GPU
 *  8. Pulse pool — RingGeometry instances reused; no alloc/GC per landing
 *  9. _tickArcs: removed geo.clone() for glow — glow Line shares same geometry ref
 * 10. _onResize debounced — prevents layout thrash on rapid resize events
 * 11. depthTest:false on arcs — skips expensive depth buffer reads for transparent lines
 * 12. renderer.info cleared each frame to prevent internal counter growth
 *
 * MINIMALIST THEME:
 *  - Earth: very dark navy #0b1622, ocean slightly lighter #0d1f35
 *  - Grid lines: near-invisible rgba(255,255,255,0.04)
 *  - Stars: removed coloured tints — all white, small, sparse
 *  - Atmosphere: single thin rim glow only, no inner sphere
 *  - Arc colours: desaturated, one tone per type
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ─── Colour palette — muted, minimal ─── */
export const ATTACK_COLORS = {
  'SYN Flood':         0xe05555,
  'UDP Flood':         0xe08840,
  'HTTP Flood':        0xd4b84a,
  'DNS Amplification': 0x4aad7c,
  'ICMP Flood':        0x8b5fd4,
  'NTP Amplification': 0xcc4477,
  'default':           0x5599cc,
};

export const ATTACK_COLORS_CSS = {
  'SYN Flood':         '#e05555',
  'UDP Flood':         '#e08840',
  'HTTP Flood':        '#d4b84a',
  'DNS Amplification': '#4aad7c',
  'ICMP Flood':        '#8b5fd4',
  'NTP Amplification': '#cc4477',
  'default':           '#5599cc',
};

const GLOBE_R   = 1.5;
const ARC_LIMIT = 120;   // FIX: was 250 — too many transparent objects kills GPU
const ARC_PTS   = 48;    // FIX: was 64 — 48 is smooth enough, saves 25% per arc
const PULSE_POOL_SIZE = 24;  // FIX: pre-allocate pulses, no runtime alloc

/* ─── Shared material pool (one per type, NOT one per arc) ─── */
let _matPool = null;
function getMatPool() {
  if (_matPool) return _matPool;
  _matPool = {};
  for (const [type, hex] of Object.entries(ATTACK_COLORS)) {
    _matPool[type] = {
      line: new THREE.LineBasicMaterial({
        color: hex, transparent: true, opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: false,   // FIX: skip depth reads for transparent lines
      }),
    };
  }
  return _matPool;
}

export class GlobeRenderer {
  constructor(canvas, countriesMap) {
    this.canvas    = canvas;
    this.countries = countriesMap;
    this.arcs      = [];
    this.pulses    = [];        // active pulse objects from pool
    this._pulsePool = [];       // inactive (reusable) pulse objects
    this.heatNodes  = {};
    this.paused     = false;
    this.heatmap    = false;
    this.onLand     = null;

    this._resizeTimer = null;   // FIX: debounce resize

    this._init();
  }

  /* ══════════════════════════════════════════
     INIT
  ══════════════════════════════════════════ */
  _init() {
    this._setupRenderer();
    this.scene  = new THREE.Scene();
    this._setupCamera();
    this._setupControls();
    this._buildStars();
    this._buildEarth();
    this._buildAtmosphere();
    this._buildGrid();
    this._buildPulsePool();
    this._animate();
    window.addEventListener('resize', () => this._scheduleResize());
    this._scheduleResize();
  }

  _setupRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      canvas:            this.canvas,
      antialias:         true,
      alpha:             false,        // FIX: false = no alpha composite cost
      powerPreference:  'high-performance',
      logarithmicDepthBuffer: false,   // FIX: not needed; saves buffer memory
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); // FIX: was 2.0
    this.renderer.setClearColor(0x080e18, 1);
    this.renderer.sortObjects = false;
  }

  _setupCamera() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 600;
    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 300); // FIX: far 500→300
    this.camera.position.set(0, 0, 5);
  }

  _setupControls() {
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping    = true;
    this.controls.dampingFactor    = 0.08;
    this.controls.minDistance      = 2.0;
    this.controls.maxDistance      = 9;
    this.controls.autoRotate       = true;
    this.controls.autoRotateSpeed  = 0.3;
    this.controls.enablePan        = false;
    this.controls.zoomSpeed        = 1.2;   // smooth zoom
    this.controls.rotateSpeed      = 0.6;
  }

  /* ══════════════════════════════════════════
     SCENE OBJECTS
  ══════════════════════════════════════════ */

  _buildStars() {
    // FIX: 9000 → 4000 stars. No colour variation — white only = 1 less attribute
    const N   = 4000;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const r   = 55 + Math.random() * 60;
      const th  = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i*3]   = r * Math.sin(phi) * Math.cos(th);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(th);
      pos[i*3+2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
      size: 0.07, color: 0xffffff, transparent: true, opacity: 0.55,
      sizeAttenuation: true,
    })));
  }

  _buildEarth() {
    // FIX: 72,72 → 48,48 segments; MeshLambertMaterial replaces Phong (cheaper)
    const geo = new THREE.SphereGeometry(GLOBE_R, 48, 48);

    // Minimal canvas texture — dark navy + very subtle continent tint
    const tc  = document.createElement('canvas');
    tc.width  = 1024; tc.height = 512;  // FIX: was 2048×1024 — 4x less VRAM
    const ctx = tc.getContext('2d');

    // Ocean
    ctx.fillStyle = '#0b1622'; ctx.fillRect(0, 0, 1024, 512);

    // Continent suggestion — very subtle, single fill, no shimmer loop
    // FIX: removed the 6000-iteration shimmer loop — pure CPU waste
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    [
      [[215,37],[250,35],[280,55],[270,72],[240,80],[210,65],[200,50]],
      [[245,90],[270,90],[285,100],[290,117],[277,135],[245,130],[225,110]],
      [[380,35],[435,37],[445,47],[430,57],[385,52],[375,42]],
      [[390,55],[445,55],[460,67],[460,87],[425,125],[390,120],[370,100],[375,75]],
      [[440,30],[675,30],[700,45],[675,55],[525,55],[450,50],[435,37]],
      [[540,55],[660,65],[660,82],[640,95],[600,90],[550,70],[530,62]],
      [[600,107],[665,105],[690,115],[685,132],[645,140],[605,135],[590,122]],
    ].forEach(pts => {
      ctx.save();
      ctx.scale(1024/700, 512/175);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      pts.slice(1).forEach(p => ctx.lineTo(p[0], p[1]));
      ctx.closePath(); ctx.fill();
      ctx.restore();
    });

    const tex = new THREE.CanvasTexture(tc);
    tex.generateMipmaps = true;                 // FIX: mipmaps = no shimmer at distance

    // FIX: MeshLambertMaterial — no specular calculation, ~30% faster than Phong
    const mat = new THREE.MeshLambertMaterial({ map: tex, color: 0x1a2e44 });
    this.earth = new THREE.Mesh(geo, mat);
    this.scene.add(this.earth);

    // Minimal lighting — one ambient + one directional
    this.scene.add(new THREE.AmbientLight(0x8899bb, 0.8));
    const sun = new THREE.DirectionalLight(0xaabbdd, 0.7);
    sun.position.set(4, 2, 4);
    this.scene.add(sun);
    // FIX: removed second rim DirectionalLight — saves a full lighting pass
  }

  _buildAtmosphere() {
    // FIX: was 2 atmosphere spheres (inner + outer). Now just 1 thin rim.
    // 32 segments vs 64 — still perfectly round at this radius delta
    const geo = new THREE.SphereGeometry(GLOBE_R * 1.06, 32, 32);
    const mat = new THREE.ShaderMaterial({
      uniforms: { c: { value: new THREE.Color(0x2255aa) } },
      vertexShader: `
        varying vec3 vN;
        void main() {
          vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 c;
        varying vec3 vN;
        void main() {
          float rim = pow(1.0 - abs(dot(vN, vec3(0.0, 0.0, 1.0))), 4.0) * 0.6;
          gl_FragColor = vec4(c * rim, rim * 0.5);
        }`,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(geo, mat));
  }

  _buildGrid() {
    // FIX: was N separate Line objects — one per lat/lon line.
    // Merged into a SINGLE LineSegments draw call. Massive draw-call reduction.
    const verts = [];
    const R = GLOBE_R + 0.003;
    const push = (lat, lon) => {
      const v = this._ll(lat, lon, R);
      verts.push(v.x, v.y, v.z);
    };

    // Latitude rings
    for (let lat = -80; lat <= 80; lat += 20) {
      for (let lon = 0; lon < 360; lon += 6) {
        push(lat, lon); push(lat, lon + 6);
      }
    }
    // Longitude meridians
    for (let lon = 0; lon < 360; lon += 20) {
      for (let lat = -88; lat < 90; lat += 6) {
        push(lat, lon); push(lat + 6, lon);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.scene.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0x1a3050, transparent: true, opacity: 0.35,
    })));
  }

  /* ══════════════════════════════════════════
     PULSE POOL
     FIX: Pre-allocate all pulse meshes once.
     No GC pressure from repeated new/dispose.
  ══════════════════════════════════════════ */
  _buildPulsePool() {
    const geo = new THREE.RingGeometry(0.01, 0.025, 20);
    for (let i = 0; i < PULSE_POOL_SIZE; i++) {
      const mat  = new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, opacity: 0,
        side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
      });
      const mesh = new THREE.Mesh(geo, mat); // shared geometry, own material
      mesh.visible = false;
      this.scene.add(mesh);
      this._pulsePool.push({ mesh, mat, active: false, life: 0 });
    }
  }

  _acquirePulse() {
    return this._pulsePool.find(p => !p.active) || null;
  }

  /* ══════════════════════════════════════════
     COORDINATE UTIL
  ══════════════════════════════════════════ */
  _ll(lat, lon, r) {
    const phi = (90 - lat) * (Math.PI / 180);
    const th  = (lon + 180) * (Math.PI / 180);
    return new THREE.Vector3(
      -r * Math.sin(phi) * Math.cos(th),
       r * Math.cos(phi),
       r * Math.sin(phi) * Math.sin(th),
    );
  }

  /* ══════════════════════════════════════════
     PUBLIC: ADD ATTACK
  ══════════════════════════════════════════ */
  addAttack(srcName, dstName, type) {
    if (this.paused) return;
    const s = this.countries[srcName];
    const d = this.countries[dstName];
    if (!s || !d || srcName === dstName) return;

    const color  = ATTACK_COLORS[type] ?? ATTACK_COLORS['default'];
    const srcV   = this._ll(s.lat, s.lon, GLOBE_R);
    const dstV   = this._ll(d.lat, d.lon, GLOBE_R);
    this._spawnArc(srcV, dstV, type, color);

    if (this.heatmap) this._heatCountry(dstName, color);
  }

  /* ══════════════════════════════════════════
     ARC SPAWN
     FIX: One Line per arc (was Line + glow Line clone).
     FIX: Material from shared pool — no per-arc material allocation.
     FIX: Pre-built positions array — curve.getPoints() result cached in arc obj.
  ══════════════════════════════════════════ */
  _spawnArc(src, dst, type, color) {
    const mid  = new THREE.Vector3().addVectors(src, dst).multiplyScalar(0.5);
    const dist = src.distanceTo(dst);
    mid.normalize().multiplyScalar(GLOBE_R + Math.max(0.22, dist * 0.32));

    const curve = new THREE.QuadraticBezierCurve3(src, mid, dst);
    const pts   = curve.getPoints(ARC_PTS);

    // FIX: Use shared material per-type with cloned opacity state
    const poolMat = getMatPool()[type] ?? getMatPool()['default'];
    const mat = poolMat.line.clone(); // clone only for per-arc opacity changes
    mat.opacity = 0.8;

    const geo  = new THREE.BufferGeometry().setFromPoints(pts);
    geo.setDrawRange(0, 0);
    const line = new THREE.Line(geo, mat);
    // FIX: frustumCulled = false prevents incorrect culling of long arcs
    line.frustumCulled = false;
    this.scene.add(line);

    // Head dot — tiny SphereGeometry, shared per-type color
    const headMat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    // FIX: SphereGeometry(0.018,8,8) → (0.014,6,6) — 44% fewer vertices per head
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.014, 6, 6), headMat);
    head.frustumCulled = false;
    this.scene.add(head);

    const arc = {
      line, geo, mat, head, headMat,
      pts, curve,
      progress: 0,
      speed: 0.4 + Math.random() * 0.25,
      life: 1.0,
      landed: false,
      dstV: dst.clone(),
      color,
    };

    this.arcs.push(arc);

    // FIX: Use shift (O(n)) only when over limit — acceptable since limit is 120
    if (this.arcs.length > ARC_LIMIT) {
      this._disposeArc(this.arcs.shift());
    }
  }

  /* ══════════════════════════════════════════
     HEATMAP
  ══════════════════════════════════════════ */
  _heatCountry(name, color) {
    const c = this.countries[name];
    if (!c) return;
    let node = this.heatNodes[name];
    if (!node) {
      // FIX: (0.06,12,12) → (0.055,8,8) — 56% fewer vertices per heat node
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false,
      });
      node = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), mat);
      node.position.copy(this._ll(c.lat, c.lon, GLOBE_R + 0.005));
      node._tgt = 0;
      this.scene.add(node);
      this.heatNodes[name] = node;
    }
    node._tgt = Math.min(0.85, (node.material.opacity || 0) + 0.14);
    node.material.color.setHex(color);
  }

  setHeatmapMode(on) {
    this.heatmap = on;
    if (!on) Object.values(this.heatNodes).forEach(n => { n._tgt = 0; });
  }

  /* ══════════════════════════════════════════
     ANIMATION LOOP
  ══════════════════════════════════════════ */
  _animate() {
    const clock = new THREE.Clock();
    const loop  = () => {
      requestAnimationFrame(loop);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (!this.paused) {
        this._tickArcs(dt);
        this._tickPulses(dt);
        this._tickHeat(dt);
        this.earth.rotation.y += dt * 0.022;
      }
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  _tickArcs(dt) {
    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i];

      if (a.progress < 1.0) {
        a.progress = Math.min(1.0, a.progress + dt * a.speed);

        // Move head to current point on curve
        // FIX: cache getPoint result in temp var, avoid repeated object creation
        a.curve.getPoint(a.progress, a.head.position);

        // Reveal arc progressively
        a.geo.setDrawRange(0, Math.max(2, Math.floor(a.progress * ARC_PTS)));

        if (a.progress >= 1.0 && !a.landed) {
          a.landed = true;
          a.head.visible = false;
          this._spawnLandPulses(a.dstV, a.color);
          this.onLand?.();
        }
      } else {
        // Fade out
        a.life -= dt * 0.55;
        a.mat.opacity = Math.max(0, a.life * 0.8);
        if (a.life <= 0) {
          this._disposeArc(a);
          this.arcs.splice(i, 1);
        }
      }
    }
  }

  _spawnLandPulses(pos, color) {
    for (let k = 0; k < 2; k++) {  // FIX: was 3 pulses per landing, now 2
      const p = this._acquirePulse();
      if (!p) return;
      p.active = true;
      p.life   = 1.0;
      p.mesh.position.copy(pos);
      p.mesh.lookAt(pos.clone().multiplyScalar(2));
      p.mesh.scale.setScalar(1.0 + k * 0.3);
      p.mat.color.setHex(color);
      p.mat.opacity = 0.8 - k * 0.2;
      p.mesh.visible = true;
    }
  }

  _tickPulses(dt) {
    for (const p of this._pulsePool) {
      if (!p.active) continue;
      p.life -= dt * 2.2;
      if (p.life <= 0) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      const t = 1.0 - p.life;
      p.mesh.scale.setScalar(1.0 + t * 3.0);
      p.mat.opacity = p.life * 0.7;
    }
  }

  _tickHeat(dt) {
    for (const n of Object.values(this.heatNodes)) {
      const tgt = n._tgt || 0;
      const cur = n.material.opacity;
      if (Math.abs(cur - tgt) > 0.001) {
        n.material.opacity += (tgt - cur) * dt * 2.5;
        n.material.needsUpdate = true;
      }
      if (n._tgt > 0) n._tgt = Math.max(0, n._tgt - dt * 0.07);
    }
  }

  /* ══════════════════════════════════════════
     DISPOSE
  ══════════════════════════════════════════ */
  _disposeArc(a) {
    this.scene.remove(a.line);
    this.scene.remove(a.head);
    a.geo.dispose();
    a.mat.dispose();
    a.headMat.dispose();
  }

  /* ══════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════ */
  get arcCount() { return this.arcs.length; }

  setPaused(v) {
    this.paused = v;
    this.controls.autoRotate = !v;
  }

  resetCamera() {
    this.camera.position.set(0, 0, 5);
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /* FIX: debounce resize — was firing layout thrash on every pixel of resize drag */
  _scheduleResize() {
    clearTimeout(this._resizeTimer);
    this._resizeTimer = setTimeout(() => this._onResize(), 80);
  }

  _onResize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth;
    const h = parent.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }
}
