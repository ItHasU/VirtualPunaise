// Définition géométrique et massique des objets lancés.
//
// Repère « objet » : l'axe z est l'axe de symétrie.
//  - Punaise : la tête (disque) occupe z ∈ [0, h], la pointe z ∈ [-L, 0].
//    L'axe +z va donc de la pointe vers le dos de la tête.
//  - Jeton : cylindre z ∈ [-h/2, h/2].
//
// Pour le contact avec un plan, seule l'enveloppe convexe de l'objet compte :
// on la représente par un nuage de points (bords des disques + pointe).
// Toutes les grandeurs sont en unités SI (m, kg).

const RIM_POINTS = 24;

const DENSITIES = {
  acier: 7850,
  laiton: 8500,
  plastique: 1200,
};

function rim(radius, z, n = RIM_POINTS) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push([radius * Math.cos(a), radius * Math.sin(a), z]);
  }
  return pts;
}

// Inertie d'un cylindre plein (masse m, rayon r, hauteur h) autour de son centre.
function cylinderInertia(m, r, h) {
  return { axial: (m * r * r) / 2, transverse: (m * (3 * r * r + h * h)) / 12 };
}

/**
 * Punaise : tête cylindrique + pointe (tige cylindrique terminée en pointe).
 * @param {object} d dimensions en millimètres
 *   headDiameter, headThickness, needleLength, needleDiameter, headMaterial, needleMaterial
 */
export function makeThumbtack(d) {
  const R = d.headDiameter / 2000;
  const h = d.headThickness / 1000;
  const L = d.needleLength / 1000;
  const r = d.needleDiameter / 2000;
  const rhoH = DENSITIES[d.headMaterial] ?? DENSITIES.acier;
  const rhoN = DENSITIES[d.needleMaterial] ?? DENSITIES.acier;

  const mh = rhoH * Math.PI * R * R * h;
  const mn = rhoN * Math.PI * r * r * L;
  const m = mh + mn;
  const zh = h / 2;
  const zn = -L / 2;
  const zc = (mh * zh + mn * zn) / m; // centre de masse sur l'axe

  const ih = cylinderInertia(mh, R, h);
  const inn = cylinderInertia(mn, r, L);
  const axial = ih.axial + inn.axial;
  const transverse =
    ih.transverse + mh * (zh - zc) ** 2 + inn.transverse + mn * (zn - zc) ** 2;

  const hull = [...rim(R, h), ...rim(R, 0), [0, 0, -L]].map(([x, y, z]) => [x, y, z - zc]);

  return {
    kind: 'punaise',
    mass: m,
    inertia: [transverse, transverse, axial],
    hull,
    comOffset: zc, // position du centre de masse dans le repère géométrique
    geometry: { R, h, L, r },
    outcomes: ['dos', 'cote'],
  };
}

/**
 * Jeton : cylindre homogène.
 * @param {object} d dimensions en millimètres : diameter, thickness, material
 */
export function makeToken(d) {
  const R = d.diameter / 2000;
  const h = d.thickness / 1000;
  const rho = DENSITIES[d.material] ?? DENSITIES.acier;
  const m = rho * Math.PI * R * R * h;
  const I = cylinderInertia(m, R, h);
  return {
    kind: 'jeton',
    mass: m,
    inertia: [I.transverse, I.transverse, I.axial],
    hull: [...rim(R, h / 2), ...rim(R, -h / 2)],
    comOffset: 0,
    geometry: { R, h },
    outcomes: ['pile', 'face', 'tranche'],
  };
}

export function makeShape(config) {
  return config.kind === 'jeton' ? makeToken(config.token) : makeThumbtack(config.thumbtack);
}

/**
 * Détermine la position finale à partir de la composante verticale (y) de l'axe z de l'objet.
 */
export function classify(shape, axisY) {
  if (shape.kind === 'jeton') {
    if (axisY > 0.9) return 'pile';
    if (axisY < -0.9) return 'face';
    return 'tranche';
  }
  // Axe +z = de la pointe vers le dos de la tête : dos au sol ⇒ axe vers le bas.
  return axisY < -0.9 ? 'dos' : 'cote';
}

export const OUTCOME_LABELS = {
  dos: 'Sur le dos (pointe en l’air)',
  cote: 'Sur le côté (pointe au sol)',
  pile: 'Pile',
  face: 'Face',
  tranche: 'Tranche',
};

export const DEFAULT_CONFIG = {
  kind: 'punaise',
  thumbtack: {
    headDiameter: 10,
    headThickness: 1,
    needleLength: 8,
    needleDiameter: 1,
    headMaterial: 'acier',
    needleMaterial: 'acier',
  },
  token: { diameter: 20, thickness: 2, material: 'plastique' },
  physics: {
    height: 0.3, // m
    spin: 10 * Math.PI, // rad/s (5 tours/s), vitesse angulaire initiale max
    lateral: 0.3, // m/s, vitesse horizontale initiale max
    restitution: 0.4,
    friction: 0.4,
  },
};
