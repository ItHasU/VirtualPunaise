// Moteur de dynamique du solide (un corps rigide contre un plan horizontal y = 0).
//
// - Intégration explicite à pas fixe, moment cinétique conservé en repère monde
//   (ce qui reproduit correctement la précession des solides non sphériques).
// - Contacts : chaque point de l'enveloppe convexe sous le plan devient un contact,
//   résolu par impulsions séquentielles (Coulomb + coefficient de restitution).
// - Le code n'utilise aucun objet du DOM : il tourne aussi bien dans la page,
//   dans un Web Worker ou sous Node.js (tests).

import { classify } from './shapes.js';

export const GRAVITY = 9.81;
export const DT = 1 / 1000; // pas de temps (s)
const SOLVER_ITERATIONS = 10;
const CONTACT_MARGIN = 2e-4; // m : marge des contacts spéculatifs
const PENETRATION_SLOP = 2e-5; // m : pénétration tolérée
const POSITION_CORRECTION = 0.3; // fraction de la pénétration corrigée à chaque pas
const BOUNCE_THRESHOLD = 0.05; // m/s : en dessous, pas de rebond
const ROLLING_DAMPING = 2.0; // 1/s : résistance au roulement quand l'objet touche le sol
const SLEEP_LINEAR = 0.005; // m/s
const SLEEP_ANGULAR = 0.3; // rad/s
const SLEEP_TIME = 0.25; // s
const MAX_TIME = 10; // s

// Générateur pseudo-aléatoire reproductible (mulberry32).
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Orientation aléatoire uniforme (méthode de Shoemake). Quaternion [w, x, y, z].
function randomQuaternion(rng) {
  const u1 = rng(), u2 = rng(), u3 = rng();
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
  const a = 2 * Math.PI * u2, b = 2 * Math.PI * u3;
  return [s2 * Math.cos(b), s1 * Math.sin(a), s1 * Math.cos(a), s2 * Math.sin(b)];
}

function randomUnitVector(rng) {
  const z = 2 * rng() - 1;
  const a = 2 * Math.PI * rng();
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), s * Math.sin(a), z];
}

export function createBody(shape) {
  let radius = 0;
  for (const p of shape.hull) radius = Math.max(radius, Math.hypot(p[0], p[1], p[2]));
  return {
    shape,
    invMass: 1 / shape.mass,
    invInertia: shape.inertia.map((i) => 1 / i),
    radius,
    x: [0, 0, 0],
    v: [0, 0, 0],
    q: [1, 0, 0, 0],
    L: [0, 0, 0],
    w: [0, 0, 0],
    pv: [0, 0, 0],
    pw: [0, 0, 0],
    R: new Float64Array(9),
    invI: new Float64Array(9),
    t: 0,
    restTime: 0,
    asleep: false,
    // tampons de contacts réutilisés à chaque pas
    contacts: shape.hull.map(() => ({
      rx: 0, ry: 0, rz: 0, depth: 0, kn: 0, kt1: 0, kt2: 0,
      target: 0, accN: 0, accT1: 0, accT2: 0, accP: 0,
    })),
    nContacts: 0,
  };
}

/**
 * Prépare un lancer aléatoire.
 * @param {object} physics height, spin, lateral, restitution, friction
 */
export function launch(body, rng, physics, x0 = 0, z0 = 0) {
  body.x = [x0, physics.height, z0];
  const a = 2 * Math.PI * rng();
  const s = physics.lateral * rng();
  body.v = [s * Math.cos(a), 0, s * Math.sin(a)];
  body.q = randomQuaternion(rng);
  updateRotation(body);
  const dir = randomUnitVector(rng);
  const wmag = physics.spin * rng();
  const w = dir.map((c) => c * wmag);
  // L = I_monde · ω
  const R = body.R, I = body.shape.inertia;
  const L = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      // (R diag(I) Rᵀ)_ij ω_j
      let row = 0;
      for (let j = 0; j < 3; j++) row += R[i * 3 + k] * I[k] * R[j * 3 + k] * w[j];
      acc += row;
    }
    L[i] = acc;
  }
  body.L = L;
  body.t = 0;
  body.restTime = 0;
  body.asleep = false;
  updateOmega(body);
}

function updateRotation(body) {
  const [w, x, y, z] = body.q;
  const R = body.R;
  R[0] = 1 - 2 * (y * y + z * z); R[1] = 2 * (x * y - w * z); R[2] = 2 * (x * z + w * y);
  R[3] = 2 * (x * y + w * z); R[4] = 1 - 2 * (x * x + z * z); R[5] = 2 * (y * z - w * x);
  R[6] = 2 * (x * z - w * y); R[7] = 2 * (y * z + w * x); R[8] = 1 - 2 * (x * x + y * y);
  // I⁻¹ monde = R diag(I⁻¹) Rᵀ
  const ii = body.invInertia, M = body.invI;
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      const val = R[i * 3] * ii[0] * R[j * 3] + R[i * 3 + 1] * ii[1] * R[j * 3 + 1] + R[i * 3 + 2] * ii[2] * R[j * 3 + 2];
      M[i * 3 + j] = val;
      M[j * 3 + i] = val;
    }
  }
}

function updateOmega(body) {
  const M = body.invI, L = body.L, w = body.w;
  w[0] = M[0] * L[0] + M[1] * L[1] + M[2] * L[2];
  w[1] = M[3] * L[0] + M[4] * L[1] + M[5] * L[2];
  w[2] = M[6] * L[0] + M[7] * L[1] + M[8] * L[2];
}

// Applique l'impulsion P au point r (relatif au centre de masse).
function applyImpulse(body, rx, ry, rz, px, py, pz) {
  const im = body.invMass;
  body.v[0] += px * im; body.v[1] += py * im; body.v[2] += pz * im;
  const L = body.L;
  L[0] += ry * pz - rz * py;
  L[1] += rz * px - rx * pz;
  L[2] += rx * py - ry * px;
  updateOmega(body);
}

// Masse effective le long de la direction n pour un contact en r : 1 / (1/m + (r×n)·I⁻¹(r×n)).
function effectiveMass(body, cx, cy, cz) {
  const M = body.invI;
  const ax = M[0] * cx + M[1] * cy + M[2] * cz;
  const ay = M[3] * cx + M[4] * cy + M[5] * cz;
  const az = M[6] * cx + M[7] * cy + M[8] * cz;
  return 1 / (body.invMass + cx * ax + cy * ay + cz * az);
}

/** Avance la simulation d'un pas de temps dt. */
export function step(body, dt, physics) {
  if (body.asleep) return;
  const v = body.v, w = body.w, x = body.x, R = body.R;
  v[1] -= GRAVITY * dt;

  // --- détection des contacts ---
  // Les points légèrement au-dessus du plan (< CONTACT_MARGIN) sont aussi retenus
  // (« contacts spéculatifs ») : cela stabilise fortement les objets au repos.
  let n = 0;
  if (x[1] < body.radius + CONTACT_MARGIN) {
    const hull = body.shape.hull;
    for (let i = 0; i < hull.length; i++) {
      const p = hull[i];
      const ry = R[3] * p[0] + R[4] * p[1] + R[5] * p[2];
      const wy = x[1] + ry;
      if (wy < CONTACT_MARGIN) {
        const c = body.contacts[n++];
        c.rx = R[0] * p[0] + R[1] * p[1] + R[2] * p[2];
        c.ry = ry;
        c.rz = R[6] * p[0] + R[7] * p[1] + R[8] * p[2];
        c.depth = -wy;
      }
    }
  }
  body.nContacts = n;

  // pseudo-vitesses de correction de position (« split impulse »)
  const pv = body.pv, pw = body.pw;
  pv[0] = pv[1] = pv[2] = 0;
  pw[0] = pw[1] = pw[2] = 0;

  // --- résolution des contacts (impulsions séquentielles) ---
  if (n > 0) {
    const e = physics.restitution;
    const mu = physics.friction;
    for (let i = 0; i < n; i++) {
      const c = body.contacts[i];
      // normale n = (0,1,0) : r×n = (-rz, 0, rx) ; t1 = (1,0,0) : r×t1 = (0, rz, -ry) ; t2 = (0,0,1) : r×t2 = (ry, -rx, 0)
      c.kn = effectiveMass(body, -c.rz, 0, c.rx);
      c.kt1 = effectiveMass(body, 0, c.rz, -c.ry);
      c.kt2 = effectiveMass(body, c.ry, -c.rx, 0);
      const vn = v[1] + w[2] * c.rx - w[0] * c.rz;
      if (c.depth >= 0) {
        c.target = vn < -BOUNCE_THRESHOLD ? -e * vn : 0;
      } else if (vn < -BOUNCE_THRESHOLD) {
        // approche rapide : on laisse le point toucher pour qu'il rebondisse au pas suivant
        c.target = -Infinity;
      } else {
        // point encore au-dessus du plan : il peut s'en approcher, sans le traverser
        c.target = c.depth / dt;
      }
      c.accN = 0; c.accT1 = 0; c.accT2 = 0; c.accP = 0;
    }
    for (let it = 0; it < SOLVER_ITERATIONS; it++) {
      for (let i = 0; i < n; i++) {
        const c = body.contacts[i];
        if (c.target === -Infinity) continue;
        const rx = c.rx, ry = c.ry, rz = c.rz;
        // composante normale
        const vy = v[1] + w[2] * rx - w[0] * rz;
        let lambda = c.kn * (c.target - vy);
        const newN = Math.max(c.accN + lambda, 0);
        lambda = newN - c.accN;
        c.accN = newN;
        if (lambda !== 0) applyImpulse(body, rx, ry, rz, 0, lambda, 0);

        // frottement (cône de Coulomb)
        const vx = v[0] + w[1] * rz - w[2] * ry;
        const vz = v[2] + w[0] * ry - w[1] * rx;
        let t1 = c.accT1 - c.kt1 * vx;
        let t2 = c.accT2 - c.kt2 * vz;
        const maxF = mu * c.accN;
        const norm = Math.hypot(t1, t2);
        if (norm > maxF) {
          const s = maxF / norm;
          t1 *= s; t2 *= s;
        }
        const d1 = t1 - c.accT1, d2 = t2 - c.accT2;
        c.accT1 = t1; c.accT2 = t2;
        if (d1 !== 0 || d2 !== 0) applyImpulse(body, rx, ry, rz, d1, 0, d2);
      }
      // correction de pénétration sur des pseudo-vitesses (n'injecte pas d'énergie)
      for (let i = 0; i < n; i++) {
        const c = body.contacts[i];
        if (c.depth <= PENETRATION_SLOP) continue;
        const rx = c.rx, rz = c.rz;
        const vy = pv[1] + pw[2] * rx - pw[0] * rz;
        const target = (POSITION_CORRECTION * (c.depth - PENETRATION_SLOP)) / dt;
        let lambda = c.kn * (target - vy);
        const newP = Math.max(c.accP + lambda, 0);
        lambda = newP - c.accP;
        c.accP = newP;
        if (lambda !== 0) {
          pv[1] += lambda * body.invMass;
          // pw += I⁻¹ (r × (0, λ, 0)) = I⁻¹ (-rz λ, 0, rx λ)
          const M = body.invI, ax = -rz * lambda, az = rx * lambda;
          pw[0] += M[0] * ax + M[2] * az;
          pw[1] += M[3] * ax + M[5] * az;
          pw[2] += M[6] * ax + M[8] * az;
        }
      }
    }
    // résistance au roulement
    const damp = Math.max(0, 1 - ROLLING_DAMPING * dt);
    body.L[0] *= damp; body.L[1] *= damp; body.L[2] *= damp;
    updateOmega(body);
  }

  // --- intégration ---
  x[0] += (v[0] + pv[0]) * dt; x[1] += (v[1] + pv[1]) * dt; x[2] += (v[2] + pv[2]) * dt;
  const q = body.q;
  const qw = q[0], qx = q[1], qy = q[2], qz = q[3];
  const ox = w[0] + pw[0], oy = w[1] + pw[1], oz = w[2] + pw[2];
  const h = 0.5 * dt;
  q[0] = qw + h * (-ox * qx - oy * qy - oz * qz);
  q[1] = qx + h * (ox * qw + oy * qz - oz * qy);
  q[2] = qy + h * (oy * qw + oz * qx - ox * qz);
  q[3] = qz + h * (oz * qw + ox * qy - oy * qx);
  const ql = Math.hypot(q[0], q[1], q[2], q[3]);
  q[0] /= ql; q[1] /= ql; q[2] /= ql; q[3] /= ql;
  updateRotation(body);
  updateOmega(body);

  // --- mise en sommeil ---
  body.t += dt;
  const speed2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const spin2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
  if (n > 0 && speed2 < SLEEP_LINEAR ** 2 && spin2 < SLEEP_ANGULAR ** 2) {
    body.restTime += dt;
  } else {
    body.restTime = 0;
  }
  if (body.restTime > SLEEP_TIME || body.t > MAX_TIME) {
    body.asleep = true;
    v[0] = v[1] = v[2] = 0;
    body.L[0] = body.L[1] = body.L[2] = 0;
    updateOmega(body);
  }
}

/** Composante verticale de l'axe de symétrie de l'objet. */
export function axisY(body) {
  return body.R[5];
}

export function outcome(body) {
  return classify(body.shape, axisY(body));
}

/** Simule un lancer complet (sans affichage) et renvoie sa position finale. */
export function simulateThrow(body, physics, rng) {
  launch(body, rng, physics);
  while (!body.asleep) step(body, DT, physics);
  return outcome(body);
}

/**
 * Énergies mécaniques (J). Énergie potentielle de pesanteur prise par rapport à la table.
 */
export function energies(body) {
  const m = body.shape.mass, v = body.v, w = body.w, L = body.L;
  const potential = m * GRAVITY * body.x[1];
  const translational = 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const rotational = 0.5 * (w[0] * L[0] + w[1] * L[1] + w[2] * L[2]);
  return { potential, translational, rotational, total: potential + translational + rotational };
}
