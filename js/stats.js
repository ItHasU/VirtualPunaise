// Outils statistiques (programme de lycée).

/** Intervalle de fluctuation / de confiance « simplifié » au seuil de 95 % : p ± 1/√n. */
export function simpleInterval(p, n) {
  if (!n) return null;
  const h = 1 / Math.sqrt(n);
  return { low: Math.max(0, p - h), high: Math.min(1, p + h), half: h };
}

/** Intervalle de confiance asymptotique à 95 % : f ± 1,96·√(f(1−f)/n). */
export function waldInterval(f, n) {
  if (!n) return null;
  const h = 1.96 * Math.sqrt((f * (1 - f)) / n);
  return { low: Math.max(0, f - h), high: Math.min(1, f + h), half: h };
}

export function intervalsOverlap(a, b) {
  return !!a && !!b && a.low <= b.high && b.low <= a.high;
}

/**
 * Test de comparaison de deux proportions (approximation normale).
 * Renvoie la statistique z et la p-valeur bilatérale.
 */
export function twoProportionTest(k1, n1, k2, n2) {
  if (!n1 || !n2) return null;
  const p = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (k1 / n1 - k2 / n2) / se;
  return { z, pValue: 2 * (1 - normalCdf(Math.abs(z))) };
}

// Fonction de répartition de la loi normale centrée réduite (Abramowitz & Stegun 7.1.26).
export function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function formatPct(x, digits = 1) {
  if (x == null || Number.isNaN(x)) return '—';
  return (100 * x).toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' %';
}
