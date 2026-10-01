// Visualisation 3D (three.js) d'une série de n lancers simulés en temps réel.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createBody, launch, step, outcome, DT } from './physics.js';

const SPACING = 0.06; // m entre deux points de chute
const MAX_STEPS_PER_FRAME = 200;

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
    this.lastTime = null;
    this.accumulator = 0;

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

  clear() {
    for (const it of this.items) this.scene.remove(it.mesh);
    this.items = [];
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
    if (this.running) {
      this.accumulator += dtReal * this.speed;
      let steps = 0;
      while (this.accumulator >= DT && steps < MAX_STEPS_PER_FRAME) {
        for (const { body } of this.items) step(body, DT, this.physics);
        this.accumulator -= DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;
      this.syncMeshes();
      if (this.items.every((it) => it.body.asleep)) {
        this.running = false;
        const res = this.resolve;
        this.resolve = null;
        res?.(this.items.map((it) => outcome(it.body)));
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
