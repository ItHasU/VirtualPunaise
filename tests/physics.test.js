import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeShape, DEFAULT_CONFIG, classify } from '../js/shapes.js';
import { createBody, simulateThrow, launch, step, makeRng, DT } from '../js/physics.js';
import { simpleInterval, twoProportionTest } from '../js/stats.js';

function config(mod = () => {}) {
  const c = structuredClone(DEFAULT_CONFIG);
  mod(c);
  return c;
}

function frequency(cfg, outcome, n = 300, seed = 1) {
  const body = createBody(makeShape(cfg));
  const rng = makeRng(seed);
  let k = 0;
  for (let i = 0; i < n; i++) if (simulateThrow(body, cfg.physics, rng) === outcome) k++;
  return k / n;
}

test('le centre de masse de la punaise est entre la pointe et la tête', () => {
  const s = makeShape(config());
  assert.ok(s.comOffset > -s.geometry.L && s.comOffset < s.geometry.h);
  assert.ok(s.mass > 0);
});

test('un objet lâché finit immobile, posé sur la table', () => {
  const cfg = config();
  const body = createBody(makeShape(cfg));
  launch(body, makeRng(3), cfg.physics);
  while (!body.asleep) step(body, DT, cfg.physics);
  assert.ok(body.t < 10, 'doit s’immobiliser avant la limite de temps');
  // le point le plus bas de l'enveloppe est (presque) au niveau de la table
  let minY = Infinity;
  for (const p of body.shape.hull) {
    const y = body.x[1] + body.R[3] * p[0] + body.R[4] * p[1] + body.R[5] * p[2];
    minY = Math.min(minY, y);
  }
  assert.ok(Math.abs(minY) < 3e-4, `hauteur du point bas : ${minY}`);
});

test('la simulation est reproductible avec la même graine', () => {
  const cfg = config();
  assert.equal(frequency(cfg, 'dos', 50, 9), frequency(cfg, 'dos', 50, 9));
});

test('le jeton tombe sur pile ou face de façon équilibrée', () => {
  const cfg = config((c) => (c.kind = 'jeton'));
  const n = 400;
  const f = frequency(cfg, 'pile', n);
  const fFace = frequency(cfg, 'face', n);
  assert.ok(Math.abs(f - fFace) < 2 / Math.sqrt(n), `pile ${f}, face ${fFace}`);
});

test('une pointe plus longue rend la position « sur le dos » moins probable', () => {
  const short = frequency(config((c) => (c.thumbtack.needleLength = 3)), 'dos');
  const long = frequency(config((c) => (c.thumbtack.needleLength = 14)), 'dos');
  assert.ok(short > long, `pointe courte ${short}, pointe longue ${long}`);
});

test('classification des positions finales', () => {
  const p = makeShape(config());
  assert.equal(classify(p, -1), 'dos');
  assert.equal(classify(p, 0.5), 'cote');
  const j = makeShape(config((c) => (c.kind = 'jeton')));
  assert.equal(classify(j, 1), 'pile');
  assert.equal(classify(j, -1), 'face');
  assert.equal(classify(j, 0), 'tranche');
});

test('outils statistiques', () => {
  const ci = simpleInterval(0.5, 100);
  assert.ok(Math.abs(ci.low - 0.4) < 1e-12 && Math.abs(ci.high - 0.6) < 1e-12);
  assert.ok(twoProportionTest(50, 100, 50, 100).pValue > 0.99);
  assert.ok(twoProportionTest(700, 1000, 500, 1000).pValue < 0.001);
});

test('le résultat ne dépend pas de l’ordre des points de l’enveloppe (pas de côté favorisé)', () => {
  for (const kind of ['jeton', 'punaise']) {
    const cfg = config((c) => (c.kind = kind));
    const shapeA = makeShape(cfg);
    const shapeB = makeShape(cfg);
    shapeB.hull.reverse();
    const a = createBody(shapeA), b = createBody(shapeB);
    const ra = makeRng(5), rb = makeRng(5);
    for (let i = 0; i < 40; i++) {
      assert.equal(simulateThrow(a, cfg.physics, ra), simulateThrow(b, cfg.physics, rb), `${kind}, lancer ${i}`);
    }
  }
});

test('le générateur aléatoire est uniforme et les graines donnent des suites distinctes', () => {
  const rng = makeRng([1, 2, 3, 4]);
  const bins = new Array(20).fill(0);
  const N = 200000;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const u = rng();
    assert.ok(u >= 0 && u < 1);
    sum += u;
    bins[Math.floor(u * 20)]++;
  }
  // khi-deux à 19 degrés de liberté : seuil à 0,1 % ≈ 43,8
  const e = N / 20;
  const chi2 = bins.reduce((acc, o) => acc + (o - e) ** 2 / e, 0);
  assert.ok(chi2 < 43.8, `khi-deux = ${chi2}`);
  assert.ok(Math.abs(sum / N - 0.5) < 0.005);
  const r1 = makeRng(1), r2 = makeRng(2);
  assert.notEqual(r1(), r2());
});

test('l’orientation de départ est uniforme (axe vers le haut une fois sur deux)', () => {
  const cfg = config((c) => (c.kind = 'jeton'));
  const body = createBody(makeShape(cfg));
  const rng = makeRng(8);
  const N = 40000;
  let up = 0, sq = 0;
  for (let i = 0; i < N; i++) {
    launch(body, rng, cfg.physics);
    const a = body.R[5];
    if (a > 0) up++;
    sq += a * a;
  }
  // 4 écarts-types de marge
  assert.ok(Math.abs(up / N - 0.5) < 4 * 0.5 / Math.sqrt(N), `part vers le haut : ${up / N}`);
  assert.ok(Math.abs(sq / N - 1 / 3) < 0.01, `E[a²] = ${sq / N}`);
});
