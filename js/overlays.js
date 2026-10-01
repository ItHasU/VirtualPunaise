// Surcouches de visualisation de la physique pour l'objet suivi :
// centre de masse, trajectoire, points de contact, forces, vitesse, vitesse angulaire.
import * as THREE from 'three';
import { GRAVITY, DT } from './physics.js';

export const OVERLAY_COLORS = {
  com: 0x111111,
  trail: 0x2a78d6,
  hull: 0xf2c200,
  contact: 0xeb6834,
  weight: 0x1baf7a,
  velocity: 0x2a78d6,
  omega: 0x7a5cff,
};

// Échelles d'affichage (m de flèche par unité physique), avec longueur maximale.
const FORCE_SCALE = 0.01; // 1 cm de flèche = le poids de l'objet
const VELOCITY_SCALE = 0.05; // 5 cm par m/s
const OMEGA_SCALE = 0.001; // 1 cm pour 10 rad/s
const MAX_ARROW = 0.08;
const MAX_FORCE_ARROW = 0.03; // les chocs atteignent des centaines de fois le poids
const MAX_ARROWS = 6;
const TRAIL_POINTS = 5000;
const IMPACT_HOLD = 0.25; // s (temps réel) : durée d'affichage d'un choc

function onTop(material) {
  material.depthTest = false;
  material.depthWrite = false;
  material.transparent = true;
  return material;
}

class Arrow {
  constructor(scene, color) {
    this.helper = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 0.01, color);
    for (const part of [this.helper.line, this.helper.cone]) {
      onTop(part.material);
      part.renderOrder = 20;
    }
    this.helper.visible = false;
    scene.add(this.helper);
    this.dir = new THREE.Vector3();
  }
  /** Affiche la flèche de vecteur (x,y,z)·scale depuis l'origine o ; renvoie false si trop petite. */
  set(o, x, y, z, scale, max = MAX_ARROW) {
    const mag = Math.hypot(x, y, z);
    const len = Math.min(mag * scale, max);
    if (len < 5e-4) {
      this.helper.visible = false;
      return;
    }
    this.dir.set(x / mag, y / mag, z / mag);
    this.helper.position.set(o[0], o[1], o[2]);
    this.helper.setDirection(this.dir);
    const head = Math.min(0.005, 0.35 * len);
    this.helper.setLength(len, head, head * 0.6);
    this.helper.visible = true;
  }
  hide() { this.helper.visible = false; }
  dispose(scene) { scene.remove(this.helper); }
}

export class PhysicsOverlay {
  constructor(scene) {
    this.scene = scene;
    this.flags = { com: true, trail: true, hull: false, forces: true, velocity: true, omega: false, transparent: false };

    this.comMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.0009, 16, 12),
      onTop(new THREE.MeshBasicMaterial({ color: OVERLAY_COLORS.com })),
    );
    const ring = new THREE.Mesh(
      new THREE.SphereGeometry(0.0013, 16, 12),
      onTop(new THREE.MeshBasicMaterial({ color: 0xffffff })),
    );
    ring.renderOrder = 20;
    this.comMarker.renderOrder = 21;
    this.comGroup = new THREE.Group();
    this.comGroup.add(ring, this.comMarker);
    scene.add(this.comGroup);

    this.trailPositions = new Float32Array(TRAIL_POINTS * 3);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    tg.setDrawRange(0, 0);
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: OVERLAY_COLORS.trail }));
    this.trail.frustumCulled = false;
    scene.add(this.trail);
    this.trailCount = 0;

    this.weightArrow = new Arrow(scene, OVERLAY_COLORS.weight);
    this.velocityArrow = new Arrow(scene, OVERLAY_COLORS.velocity);
    this.omegaArrow = new Arrow(scene, OVERLAY_COLORS.omega);
    this.contactArrows = Array.from({ length: MAX_ARROWS }, () => new Arrow(scene, OVERLAY_COLORS.contact));

    const dots = new THREE.SphereGeometry(0.0006, 8, 6);
    this.contactDots = Array.from({ length: MAX_ARROWS }, () => {
      const m = new THREE.Mesh(dots, onTop(new THREE.MeshBasicMaterial({ color: OVERLAY_COLORS.contact })));
      m.renderOrder = 22;
      m.visible = false;
      scene.add(m);
      return m;
    });

    this.item = null;
    this.hullPoints = null;
    this.snapshot = null; // contacts affichés
    this.held = null; // dernier choc, maintenu à l'écran
    this.peakForce = 0; // en multiples du poids
    this.shownForce = 0;
  }

  /** Choisit l'objet suivi (item = { body, mesh }). */
  attach(item) {
    if (this.hullPoints) this.hullPoints.parent?.remove(this.hullPoints);
    this.restoreOpacity();
    this.item = item;
    this.trailCount = 0;
    this.trail.geometry.setDrawRange(0, 0);
    this.snapshot = null;
    this.held = null;
    this.peakForce = 0;
    this.shownForce = 0;
    if (!item) {
      this.hideAll();
      return;
    }
    const hull = item.body.shape.hull;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(hull.flat()), 3));
    this.hullPoints = new THREE.Points(
      g,
      onTop(new THREE.PointsMaterial({ color: OVERLAY_COLORS.hull, size: 5, sizeAttenuation: false })),
    );
    this.hullPoints.renderOrder = 19;
    item.mesh.add(this.hullPoints);
    this.applyOpacity();
  }

  setFlag(name, value) {
    this.flags[name] = value;
    if (name === 'transparent') {
      this.restoreOpacity();
      this.applyOpacity();
    }
  }

  applyOpacity() {
    if (!this.item || !this.flags.transparent) return;
    this.item.mesh.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        m.transparent = true;
        m.opacity = 0.35;
        m.depthWrite = false;
      }
    });
  }

  restoreOpacity() {
    this.item?.mesh.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        m.transparent = false;
        m.opacity = 1;
        m.depthWrite = true;
      }
    });
  }

  /**
   * Mémorise les contacts d'un pas de calcul (appelé après chaque pas sur l'objet suivi) :
   * on garde, pour l'image en cours, le pas où l'impulsion normale totale est la plus forte.
   */
  recordStep(body) {
    let total = 0;
    for (let i = 0; i < body.nContacts; i++) total += body.contacts[i].accN;
    if (this.frameBest && total <= this.frameBest.total) return;
    const contacts = [];
    for (let i = 0; i < body.nContacts; i++) {
      const c = body.contacts[i];
      if (c.accN > 0) contacts.push({ x: body.x[0] + c.rx, y: body.x[1] + c.ry, z: body.x[2] + c.rz, n: c.accN, t1: c.accT1, t2: c.accT2 });
    }
    contacts.sort((a, b) => b.n - a.n);
    this.frameBest = { total, contacts: contacts.slice(0, MAX_ARROWS) };
  }

  /** Mise à jour graphique, une fois par image. */
  update(realDt) {
    const item = this.item;
    if (!item) return;
    const body = item.body;
    const f = this.flags;
    const x = body.x;
    const weight = body.shape.mass * GRAVITY;

    this.comGroup.visible = f.com;
    this.comGroup.position.set(x[0], x[1], x[2]);
    if (this.hullPoints) this.hullPoints.visible = f.hull;

    // trajectoire du centre de masse
    this.trail.visible = f.trail;
    const k = this.trailCount;
    const p = this.trailPositions;
    const moved = k === 0 || Math.hypot(p[3 * k - 3] - x[0], p[3 * k - 2] - x[1], p[3 * k - 1] - x[2]) > 3e-4;
    if (moved && k < TRAIL_POINTS) {
      p[3 * k] = x[0]; p[3 * k + 1] = x[1]; p[3 * k + 2] = x[2];
      this.trailCount++;
      this.trail.geometry.setDrawRange(0, this.trailCount);
      this.trail.geometry.attributes.position.needsUpdate = true;
    }

    // vitesse et vitesse angulaire
    if (f.velocity && !body.asleep) this.velocityArrow.set(x, body.v[0], body.v[1], body.v[2], VELOCITY_SCALE);
    else this.velocityArrow.hide();
    if (f.omega && !body.asleep) this.omegaArrow.set(x, body.w[0], body.w[1], body.w[2], OMEGA_SCALE);
    else this.omegaArrow.hide();

    // forces : poids au centre de masse, réactions de la table aux points de contact
    if (f.forces) this.weightArrow.set(x, 0, -weight, 0, FORCE_SCALE / weight);
    else this.weightArrow.hide();

    const best = this.frameBest;
    this.frameBest = null;
    if (best) {
      const force = best.total / DT / weight;
      this.peakForce = Math.max(this.peakForce, force);
      // un choc (force nettement supérieure au poids) reste affiché un court instant
      if (force > 3) this.held = { ...best, ttl: IMPACT_HOLD };
      this.snapshot = best;
    }
    if (this.held && realDt > 0) {
      this.held.ttl -= realDt;
      if (this.held.ttl <= 0) this.held = null;
    }
    const shown = this.held ?? this.snapshot;
    // force de contact totale affichée, en multiples du poids
    this.shownForce = shown ? shown.total / DT / weight : 0;
    for (let i = 0; i < MAX_ARROWS; i++) {
      const c = shown?.contacts[i];
      const arrow = this.contactArrows[i], dot = this.contactDots[i];
      if (!f.forces || !c) {
        arrow.hide();
        dot.visible = false;
        continue;
      }
      dot.visible = true;
      dot.position.set(c.x, c.y, c.z);
      arrow.set([c.x, c.y, c.z], c.t1 / DT, c.n / DT, c.t2 / DT, FORCE_SCALE / weight, MAX_FORCE_ARROW);
    }
  }

  hideAll() {
    this.comGroup.visible = false;
    this.trail.visible = false;
    for (const a of [this.weightArrow, this.velocityArrow, this.omegaArrow, ...this.contactArrows]) a.hide();
    for (const d of this.contactDots) d.visible = false;
  }
}
