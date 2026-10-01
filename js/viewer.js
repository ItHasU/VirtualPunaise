// Visualisation 3D (three.js) d'une série de n lancers simulés en temps réel.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createBody, launch, step, outcome, energies, DT } from './physics.js';
import { PhysicsOverlay } from './overlays.js';

const SPACING = 0.06; // m entre deux points de chute
const MAX_STEPS_PER_FRAME = 200;
const SAMPLE_PERIOD = 0.002; // s (temps simulé) entre deux mesures d'énergie
const MAX_SAMPLES = 6000;

function faceTexture(letter, bg, fg) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = fg;
  g.font = 'bold 80px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Construit le maillage d'un objet ; son origine est le centre de masse (repère physique).
function buildMesh(shape) {
  const group = new THREE.Group();
  const zc = shape.comOffset;
  const add = (geom, mat, z) => {
    const m = new THREE.Mesh(geom, mat);
    m.position.z = z - zc;
    m.castShadow = true;
    group.add(m);
  };
  if (shape.kind === 'jeton') {
    const { R, h } = shape.geometry;
    const geom = new THREE.CylinderGeometry(R, R, h, 48);
    geom.rotateX(Math.PI / 2); // axe du cylindre selon +z ; face « haut » (+y) → +z
    const side = new THREE.MeshStandardMaterial({ color: 0xb08d2f, metalness: 0.4, roughness: 0.5 });
    const pile = new THREE.MeshStandardMaterial({ map: faceTexture('P', '#d9b44a', '#5b4512') });
    const face = new THREE.MeshStandardMaterial({ map: faceTexture('F', '#9fb7d6', '#1d3557') });
    add(geom, [side, pile, face], 0);
  } else {
    const { R, h, L, r } = shape.geometry;
    const head = new THREE.CylinderGeometry(R, R, h, 48);
    head.rotateX(Math.PI / 2);
    add(head, new THREE.MeshStandardMaterial({ color: 0xd2453d, metalness: 0.3, roughness: 0.45 }), h / 2);
    const steel = new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.9, roughness: 0.3 });
    const shaft = new THREE.CylinderGeometry(r, r, 0.8 * L, 16);
    shaft.rotateX(Math.PI / 2);
    add(shaft, steel, -0.4 * L);
    const tip = new THREE.ConeGeometry(r, 0.2 * L, 16);
    tip.rotateX(-Math.PI / 2); // pointe dirigée vers -z
    add(tip, steel, -0.9 * L);
  }
  return group;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe9eef2);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.002, 20);
    this.camera.position.set(0, 0.27, 0.34);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 0, 0.01);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02;
    this.controls.update();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(0.3, 1, 0.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -0.5, right: 0.5, top: 0.5, bottom: -0.5, near: 0.1, far: 3 });
    this.scene.add(sun);

    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 3),
      new THREE.MeshStandardMaterial({ color: 0xc9a77c, roughness: 0.9 }),
    );
    table.rotation.x = -Math.PI / 2;
    table.receiveShadow = true;
    this.scene.add(table);
    const grid = new THREE.GridHelper(1, 20, 0x8a6d4b, 0xa88a65);
    grid.position.y = 0.0002;
    this.scene.add(grid);

    this.items = [];
    this.speed = 1;
    this.running = false;
    this.paused = false;
    this.follow = false;
    this.lastTime = null;
    this.accumulator = 0;
    this.overlay = new PhysicsOverlay(this.scene);
    this.selected = null;
    this.samples = null;
    this.onSelect = null; // rappel quand l'objet suivi change

    // clic (sans glisser) sur un objet : il devient l'objet suivi
    const canvas = this.renderer.domElement;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
    canvas.addEventListener('pointerup', (e) => {
      if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) < 5) this.pick(e);
      down = null;
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.items.map((it) => it.mesh), true);
    const hit = hits.find((h) => h.object.isMesh);
    if (!hit) return;
    const item = this.items.find((it) => it.mesh === hit.object.parent || it.mesh === hit.object);
    if (item) this.select(item);
  }

  select(item) {
    this.selected = item;
    this.overlay.attach(item);
    this.samples = { t: [], potential: [], translational: [], rotational: [], total: [] };
    this.sample(true);
    this.onSelect?.(item);
  }

  // Mesure des énergies de l'objet suivi (au plus une fois toutes les SAMPLE_PERIOD s simulées).
  sample(force = false) {
    const b = this.selected?.body, S = this.samples;
    if (!b || !S || S.t.length >= MAX_SAMPLES) return;
    const last = S.t[S.t.length - 1];
    if (!force && b.t - last < SAMPLE_PERIOD) return;
    const e = energies(b);
    S.t.push(b.t);
    for (const k of ['potential', 'translational', 'rotational', 'total']) S[k].push(e[k]);
  }

  /** Rapproche la caméra de l'objet suivi (distance en m), sans changer l'angle de vue. */
  frameSelected(distance) {
    const b = this.selected?.body.x;
    if (!b) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.set(b[0], b[1], b[2]);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, distance);
  }

  resetView() {
    this.camera.position.set(0, 0.27, 0.34);
    this.controls.target.set(0, 0, 0.01);
  }

  setPaused(p) {
    this.paused = p;
  }

  /** Avance d'un seul pas de calcul (en pause). */
  stepOnce() {
    if (!this.running) return;
    this.advance(1);
    this.syncMeshes();
    this.overlay.update(0);
    this.checkFinished();
  }

  advance(steps) {
    for (let s = 0; s < steps; s++) {
      for (const it of this.items) {
        step(it.body, DT, this.physics);
        if (it === this.selected) {
          this.overlay.recordStep(it.body);
          this.sample();
        }
      }
    }
  }

  checkFinished() {
    if (this.running && this.items.every((it) => it.body.asleep)) {
      this.running = false;
      const res = this.resolve;
      this.resolve = null;
      res?.(this.items.map((it) => outcome(it.body)));
    }
  }

  clear() {
    for (const it of this.items) this.scene.remove(it.mesh);
    this.items = [];
    this.overlay.attach(null);
    this.selected = null;
    this.running = false;
    if (this.resolve) this.resolve(null);
    this.resolve = null;
  }

  /**
   * Lance une série de n objets. Renvoie une promesse résolue avec la liste
   * des positions finales (ou null si la série est interrompue).
   */
  launchSeries(shape, physics, n, rng) {
    this.clear();
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    for (let i = 0; i < n; i++) {
      const cx = ((i % cols) - (cols - 1) / 2) * SPACING;
      const cz = (Math.floor(i / cols) - (rows - 1) / 2) * SPACING;
      const jitter = SPACING * 0.3;
      const body = createBody(shape);
      launch(body, rng, physics, cx + (rng() - 0.5) * jitter, cz + (rng() - 0.5) * jitter);
      const mesh = buildMesh(shape);
      this.scene.add(mesh);
      this.items.push({ body, mesh });
    }
    this.physics = physics;
    this.syncMeshes();
    this.running = true;
    this.accumulator = 0;
    this.select(this.items[0]);
    return new Promise((res) => (this.resolve = res));
  }

  syncMeshes() {
    for (const { body, mesh } of this.items) {
      mesh.position.set(body.x[0], body.x[1], body.x[2]);
      mesh.quaternion.set(body.q[1], body.q[2], body.q[3], body.q[0]);
    }
  }

  frame(t) {
    const dtReal = this.lastTime == null ? 0 : Math.min((t - this.lastTime) / 1000, 0.05);
    this.lastTime = t;
    if (this.running && !this.paused) {
      this.accumulator += dtReal * this.speed;
      const steps = Math.min(Math.floor(this.accumulator / DT), MAX_STEPS_PER_FRAME);
      this.advance(steps);
      this.accumulator = steps === MAX_STEPS_PER_FRAME ? 0 : this.accumulator - steps * DT;
      this.syncMeshes();
      this.checkFinished();
    }
    if (this.items.length) this.overlay.update(this.paused ? 0 : dtReal);
    if (this.follow && this.selected) {
      // la caméra accompagne l'objet suivi en gardant son orientation
      const b = this.selected.body.x;
      const target = this.controls.target;
      const k = 1 - Math.exp(-8 * dtReal);
      const dx = (b[0] - target.x) * k, dy = (Math.max(b[1], 0) - target.y) * k, dz = (b[2] - target.z) * k;
      target.x += dx; target.y += dy; target.z += dz;
      this.camera.position.x += dx; this.camera.position.y += dy; this.camera.position.z += dz;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
