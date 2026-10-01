import { makeShape, DEFAULT_CONFIG, OUTCOME_LABELS, classify } from './shapes.js';
import { makeRng } from './physics.js';
import { simpleInterval, waldInterval, intervalsOverlap, twoProportionTest, formatPct } from './stats.js';
import { FrequencyChart, SeriesHistogram, EnergyChart } from './charts.js';
import { BUILD_INFO } from './build-info.js';

const $ = (sel) => document.querySelector(sel);
const STORAGE_CONFIG = 'virtualpunaise.config';
const STORAGE_REAL = 'virtualpunaise.real';
// Issue dont on estime la probabilité.
const TARGET = { punaise: 'dos', jeton: 'pile' };

// ---------------------------------------------------------------- stockage local
function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* stockage indisponible : on continue sans */
  }
}

function mergeConfig(base, extra) {
  const out = structuredClone(base);
  for (const k of ['thumbtack', 'token', 'physics']) Object.assign(out[k], extra?.[k] ?? {});
  if (extra?.kind === 'jeton' || extra?.kind === 'punaise') out.kind = extra.kind;
  return out;
}

// ---------------------------------------------------------------- état
let config = mergeConfig(DEFAULT_CONFIG, load(STORAGE_CONFIG, null));
let shape = makeShape(config);
const results = {
  outcomes: new Uint8Array(1 << 14),
  count: 0,
  series: [], // nombre d'issues « cibles » par série
  seriesSize: 20,
};
let realData = load(STORAGE_REAL, { punaise: [], jeton: [] });

let viewer = null;
const freqChart = new FrequencyChart($('#freq-chart'));
const seriesChart = new SeriesHistogram($('#series-chart'));
const energyChart = new EnergyChart($('#energy-chart'));

function randomSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

// ---------------------------------------------------------------- paramètres
function getPath(obj, path) {
  return path.split('.').reduce((o, k) => o[k], obj);
}
function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = value;
}

function fillForm() {
  document.querySelector(`input[name="kind"][value="${config.kind}"]`).checked = true;
  for (const el of document.querySelectorAll('[data-path]')) {
    const v = getPath(config, el.dataset.path);
    if (el.tagName === 'SELECT') el.value = v;
    else el.value = +(v / (+el.dataset.scale || 1)).toFixed(3);
  }
  for (const fs of document.querySelectorAll('fieldset[data-kind]')) fs.hidden = fs.dataset.kind !== config.kind;
}

function readForm() {
  const next = structuredClone(config);
  next.kind = document.querySelector('input[name="kind"]:checked').value;
  for (const el of document.querySelectorAll('[data-path]')) {
    if (el.tagName === 'SELECT') {
      setPath(next, el.dataset.path, el.value);
      continue;
    }
    let v = parseFloat(el.value);
    if (!Number.isFinite(v)) continue;
    v = Math.min(Math.max(v, +el.min), +el.max);
    setPath(next, el.dataset.path, v * (+el.dataset.scale || 1));
  }
  return next;
}

function applyConfig(next) {
  const changed = JSON.stringify(next) !== JSON.stringify(config);
  config = next;
  shape = makeShape(config);
  save(STORAGE_CONFIG, config);
  fillForm();
  updateMassInfo();
  if (changed) {
    stopBatch();
    viewer?.clear();
    if (results.count) toast('Paramètres modifiés : les résultats ont été remis à zéro.');
    clearResults();
  }
}

function updateMassInfo() {
  const g = (shape.mass * 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
  let txt = `Masse : ${g} g`;
  if (shape.kind === 'punaise') {
    const mm = (shape.comOffset * 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    txt += ` · centre de masse à ${mm} mm de la base de la tête (côté ${shape.comOffset >= 0 ? 'tête' : 'pointe'})`;
  }
  $('#mass-info').textContent = txt;
}

// ---------------------------------------------------------------- résultats
function addOutcomes(indices) {
  const needed = results.count + indices.length;
  if (needed > results.outcomes.length) {
    let size = results.outcomes.length;
    while (size < needed) size *= 2;
    const bigger = new Uint8Array(size);
    bigger.set(results.outcomes.subarray(0, results.count));
    results.outcomes = bigger;
  }
  results.outcomes.set(indices, results.count);
  results.count = needed;
}

function addSeries(indices) {
  const t = shape.outcomes.indexOf(TARGET[shape.kind]);
  results.series.push(indices.reduce((k, i) => k + (i === t), 0));
}

function clearResults() {
  results.count = 0;
  results.series = [];
  scheduleRender();
}

let renderPending = false;
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderResults();
  });
}

function realTotals() {
  const rows = realData[config.kind] ?? [];
  let n = 0, k = 0;
  for (const r of rows) {
    n += +r.n || 0;
    k += +r.k || 0;
  }
  return { n, k };
}

function renderResults() {
  const target = TARGET[shape.kind];
  const t = shape.outcomes.indexOf(target);
  const counts = new Array(shape.outcomes.length).fill(0);
  for (let i = 0; i < results.count; i++) counts[results.outcomes[i]]++;
  const N = results.count;
  const k = counts[t];
  const f = N ? k / N : null;

  $('#stat-total').textContent = N.toLocaleString('fr-FR');
  $('#stat-target-label').textContent = OUTCOME_LABELS[target];
  $('#stat-freq').textContent = formatPct(f);
  const ci = N ? simpleInterval(f, N) : null;
  $('#stat-ci').textContent = ci ? `IC 95 % : [${formatPct(ci.low)} ; ${formatPct(ci.high)}]` : '';

  $('#outcome-table').innerHTML = shape.outcomes
    .map((o, i) => `<tr><td>${OUTCOME_LABELS[o]}</td><td>${counts[i].toLocaleString('fr-FR')}</td><td>${formatPct(N ? counts[i] / N : null)}</td></tr>`)
    .join('');

  // séries
  const n = results.seriesSize;
  const S = results.series.length;
  $('#stat-series').textContent = `${S.toLocaleString('fr-FR')}`;
  const freqs = results.series.map((c) => c / n);
  const fluct = f != null ? simpleInterval(f, n) : null;
  if (S && fluct) {
    const inside = freqs.filter((x) => x >= fluct.low - 1e-12 && x <= fluct.high + 1e-12).length;
    $('#stat-in-interval').textContent = `de ${n} lancers · ${formatPct(inside / S, 0)} dans [p ± 1/√n]`;
  } else {
    $('#stat-in-interval').textContent = `de ${n} lancers`;
  }

  // expérience réelle
  const real = realTotals();
  const fr = real.n ? real.k / real.n : null;
  const realCi = real.n ? simpleInterval(fr, real.n) : null;
  freqChart.update({
    outcomes: results.outcomes,
    count: N,
    target: t,
    real: realCi ? { f: fr, low: realCi.low, high: realCi.high } : null,
  });
  seriesChart.update({ freqs, n, interval: fluct });
  renderComparison({ N, k, f, ci, real, fr, realCi, target });
}

function renderComparison({ N, k, f, ci, real, fr, realCi, target }) {
  $('#real-total-n').textContent = real.n.toLocaleString('fr-FR');
  $('#real-total-k').textContent = real.k.toLocaleString('fr-FR');
  const el = $('#comparison');
  if (!real.n) {
    el.innerHTML = '<p class="hint">Aucune donnée réelle saisie.</p>';
    return;
  }
  if (real.k > real.n) {
    el.innerHTML = '<p class="warn">Le nombre de « ' + OUTCOME_LABELS[target] + ' » dépasse le nombre de lancers.</p>';
    return;
  }
  const wald = waldInterval(fr, real.n);
  let html = `<dl>
    <dt>Fréquence réelle</dt><dd><b>${formatPct(fr)}</b> sur ${real.n.toLocaleString('fr-FR')} lancers</dd>
    <dt>Intervalle de confiance (f ± 1/√n)</dt><dd>[${formatPct(realCi.low)} ; ${formatPct(realCi.high)}]</dd>
    <dt>Intervalle de confiance (f ± 1,96·√(f(1−f)/n))</dt><dd>[${formatPct(wald.low)} ; ${formatPct(wald.high)}]</dd>`;
  if (N) {
    html += `<dt>Fréquence simulée</dt><dd><b>${formatPct(f)}</b> sur ${N.toLocaleString('fr-FR')} lancers, IC [${formatPct(ci.low)} ; ${formatPct(ci.high)}]</dd>`;
    const test = twoProportionTest(k, N, real.k, real.n);
    html += `<dt>Écart</dt><dd>${((f - fr) * 100).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} points · test de comparaison de proportions : p-valeur ≈ ${test.pValue.toLocaleString('fr-FR', { maximumSignificantDigits: 2 })}</dd>`;
    html += '</dl>';
    const ok = intervalsOverlap(ci, realCi) && test.pValue >= 0.05;
    html += ok
      ? '<p class="verdict ok">✔ Simulation et expérience sont <b>compatibles</b> au seuil de 5 %.</p>'
      : '<p class="verdict ko">✘ L’écart entre simulation et expérience est <b>significatif</b> au seuil de 5 % : le modèle (ou ses paramètres) ne reproduit pas l’expérience.</p>';
  } else {
    html += '</dl><p class="hint">Lancez des simulations pour comparer.</p>';
  }
  el.innerHTML = html;
}

// ---------------------------------------------------------------- expérience réelle
function renderRealTable() {
  const rows = (realData[config.kind] ??= []);
  $('#real-target-head').textContent = `« ${OUTCOME_LABELS[TARGET[config.kind]]} »`;
  const tbody = $('#real-table');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><input type="text" data-f="name" aria-label="Groupe"></td>
      <td><input type="number" min="0" step="1" data-f="n" aria-label="Lancers"></td>
      <td><input type="number" min="0" step="1" data-f="k" aria-label="Effectif"></td>
      <td><button type="button" class="icon" aria-label="Supprimer la ligne" title="Supprimer">×</button></td>`;
    for (const inp of tr.querySelectorAll('input')) {
      inp.value = r[inp.dataset.f] ?? '';
      inp.addEventListener('input', () => {
        r[inp.dataset.f] = inp.type === 'number' ? (inp.value === '' ? '' : Math.max(0, Math.round(+inp.value))) : inp.value;
        save(STORAGE_REAL, realData);
        scheduleRender();
      });
    }
    tr.querySelector('button').addEventListener('click', () => {
      rows.splice(i, 1);
      save(STORAGE_REAL, realData);
      renderRealTable();
      scheduleRender();
    });
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------------- vue 3D
let seriesRng = makeRng(randomSeed());
let launching = false;
/**
 * Lance une série dans la vue 3D. Par défaut, n = taille de série choisie ;
 * `single` lance un seul objet au ralenti, suivi par la caméra.
 */
async function throwSeries({ single = false } = {}) {
  if (!viewer || launching) return;
  const n = single ? 1 : readSeriesSize();
  if (single) {
    $('#speed').value = '0.05';
    $('#follow').checked = true;
    $('#auto-series').checked = false;
  }
  viewer.speed = +$('#speed').value;
  viewer.follow = $('#follow').checked;
  launching = true;
  setRunningUi(true);
  $('#series-result').textContent = single ? 'Lancer au ralenti en cours…' : 'Lancer en cours…';
  const promise = viewer.launchSeries(shape, config.physics, n, seriesRng);
  if (single) viewer.frameSelected(0.12);
  const res = await promise;
  launching = false;
  setRunningUi(false);
  if (!res) return;
  const idx = res.map((o) => shape.outcomes.indexOf(o));
  addOutcomes(idx);
  if (n === results.seriesSize) addSeries(idx);
  const counts = shape.outcomes.map((o) => `${OUTCOME_LABELS[o]} : ${res.filter((r) => r === o).length}`);
  $('#series-result').textContent = single ? `Lancer unique : ${OUTCOME_LABELS[res[0]]}` : `Série de ${n} : ${counts.join(' · ')}`;
  scheduleRender();
  if (!single && $('#auto-series').checked) setTimeout(() => $('#auto-series').checked && throwSeries(), 600);
}

function setRunningUi(running) {
  $('#throw-series').disabled = running;
  $('#slow-single').disabled = running;
  $('#pause').disabled = !running;
  $('#step-once').disabled = !running;
  if (viewer) viewer.setPaused(false);
  $('#pause').textContent = '⏸ Pause';
}

function togglePause() {
  if (!viewer) return;
  viewer.setPaused(!viewer.paused);
  $('#pause').textContent = viewer.paused ? '▶ Reprendre' : '⏸ Pause';
}

// Mesures en direct de l'objet suivi.
const fmt = (v, d = 2) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
function updateReadout() {
  const item = viewer?.selected;
  const set = (k, v) => (document.querySelector(`#readout [data-r="${k}"]`).textContent = v);
  if (!item) {
    for (const k of ['t', 'h', 'v', 'w', 'n', 'fc', 'f', 'state']) set(k, '—');
    energyChart.update(null);
    return;
  }
  const b = item.body;
  set('t', `${fmt(b.t, 3)} s`);
  set('h', `${fmt(b.x[1] * 100, 2)} cm`);
  set('v', `${fmt(Math.hypot(...b.v), 2)} m/s`);
  const w = Math.hypot(...b.w);
  set('w', `${fmt(w, 1)} rad/s (${fmt(w / (2 * Math.PI), 1)} tr/s)`);
  set('n', b.asleep ? '—' : String(b.nContacts ? [...b.contacts.slice(0, b.nContacts)].filter((c) => c.accN > 0).length : 0));
  const fc = viewer.overlay.shownForce;
  set('fc', fc ? `${fmt(fc, fc < 10 ? 2 : 0)} × le poids` : '0');
  set('f', viewer.overlay.peakForce ? `${fmt(viewer.overlay.peakForce, 0)} × le poids` : '—');
  set('state', b.asleep ? `Immobile : ${OUTCOME_LABELS[outcomeOf(b)]}` : b.nContacts ? 'Au contact de la table' : 'En vol');
  energyChart.update(viewer.samples);
}

function outcomeOf(body) {
  return classify(body.shape, body.R[5]);
}

function readSeriesSize() {
  const el = $('#series-size');
  const n = Math.min(100, Math.max(1, Math.round(+el.value || 1)));
  el.value = n;
  if (n !== results.seriesSize) {
    results.seriesSize = n;
    results.series = [];
    scheduleRender();
  }
  return n;
}

// ---------------------------------------------------------------- simulation rapide
let workers = [];
function stopBatch() {
  for (const w of workers) w.terminate();
  workers = [];
  $('#batch-run').disabled = false;
  $('#batch-stop').disabled = true;
  $('#batch-progress').hidden = true;
}

function runBatch() {
  stopBatch();
  const n = readSeriesSize();
  const S = Math.min(100000, Math.max(1, Math.round(+$('#batch-series').value || 1)));
  $('#batch-series').value = S;
  const nWorkers = Math.max(1, Math.min(S, (navigator.hardwareConcurrency || 4) - 1, 8));
  const total = S * n;
  let done = 0;
  let finished = 0;
  const t0 = performance.now();
  const progress = $('#batch-progress');
  progress.hidden = false;
  progress.value = 0;
  $('#batch-run').disabled = true;
  $('#batch-stop').disabled = false;
  $('#batch-info').textContent = `${nWorkers} calcul(s) en parallèle…`;

  for (let w = 0; w < nWorkers; w++) {
    const seriesForWorker = Math.floor(S / nWorkers) + (w < S % nWorkers ? 1 : 0);
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    let pending = []; // lancers de la série en cours pour ce calcul
    worker.onmessage = (ev) => {
      if (ev.data.finished) {
        if (++finished === nWorkers) {
          const s = ((performance.now() - t0) / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
          stopBatch();
          $('#batch-info').textContent = `${total.toLocaleString('fr-FR')} lancers simulés en ${s} s.`;
        }
        return;
      }
      const res = Array.from(ev.data.results);
      addOutcomes(res);
      for (const r of res) {
        pending.push(r);
        if (pending.length === n) {
          addSeries(pending);
          pending = [];
        }
      }
      done += res.length;
      progress.value = done / total;
      scheduleRender();
    };
    worker.onerror = (e) => {
      stopBatch();
      $('#batch-info').textContent = `Erreur du calcul : ${e.message}`;
    };
    worker.postMessage({ config, throws: seriesForWorker * n, seed: randomSeed() });
    workers.push(worker);
  }
}

// ---------------------------------------------------------------- export
function exportCsv() {
  const target = OUTCOME_LABELS[TARGET[shape.kind]];
  const n = results.seriesSize;
  const lines = [`serie;lancers;"${target}";frequence`];
  results.series.forEach((k, i) => lines.push(`${i + 1};${n};${k};${(k / n).toFixed(4).replace('.', ',')}`));
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `series-${shape.kind}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

// ---------------------------------------------------------------- initialisation
function init() {
  $('#build-info').textContent = BUILD_INFO.date
    ? `Version générée le ${BUILD_INFO.date} (commit ${BUILD_INFO.commit})`
    : 'Version de développement';
  fillForm();
  updateMassInfo();
  renderRealTable();
  for (const el of document.querySelectorAll('.settings input, .settings select')) {
    el.addEventListener('change', () => {
      const prevKind = config.kind;
      applyConfig(readForm());
      if (config.kind !== prevKind) renderRealTable();
    });
  }
  $('#reset-config').addEventListener('click', () => {
    applyConfig(mergeConfig(DEFAULT_CONFIG, { kind: config.kind }));
  });
  $('#throw-series').addEventListener('click', () => throwSeries());
  $('#slow-single').addEventListener('click', () => throwSeries({ single: true }));
  $('#pause').addEventListener('click', togglePause);
  $('#step-once').addEventListener('click', () => {
    if (!viewer?.running) return;
    if (!viewer.paused) togglePause();
    viewer.stepOnce();
    updateReadout();
  });
  $('#reset-view').addEventListener('click', () => {
    $('#follow').checked = false;
    if (viewer) {
      viewer.follow = false;
      viewer.resetView();
    }
  });
  $('#follow').addEventListener('change', (e) => viewer && (viewer.follow = e.target.checked));
  for (const el of document.querySelectorAll('[data-overlay]')) {
    el.addEventListener('change', () => viewer?.overlay.setFlag(el.dataset.overlay, el.checked));
  }
  $('#auto-series').addEventListener('change', (e) => {
    if (e.target.checked && !$('#throw-series').disabled) throwSeries();
  });
  $('#speed').addEventListener('change', (e) => viewer && (viewer.speed = +e.target.value));
  $('#series-size').addEventListener('change', () => {
    if (workers.length) stopBatch();
    readSeriesSize();
  });
  $('#batch-run').addEventListener('click', runBatch);
  $('#batch-stop').addEventListener('click', () => {
    stopBatch();
    $('#batch-info').textContent = 'Simulation interrompue.';
  });
  $('#clear-results').addEventListener('click', () => {
    stopBatch();
    clearResults();
  });
  $('#real-add').addEventListener('click', () => {
    (realData[config.kind] ??= []).push({ name: `Groupe ${realData[config.kind].length + 1}`, n: '', k: '' });
    save(STORAGE_REAL, realData);
    renderRealTable();
  });
  $('#export-csv').addEventListener('click', exportCsv);
  readSeriesSize();
  scheduleRender();

  // La vue 3D (three.js + WebGL) est chargée à part : si elle échoue,
  // la simulation rapide reste utilisable.
  import('./viewer.js')
    .then(({ Viewer }) => {
      viewer = new Viewer($('#viewer'));
      viewer.speed = +$('#speed').value;
      for (const el of document.querySelectorAll('[data-overlay]')) viewer.overlay.setFlag(el.dataset.overlay, el.checked);
      setInterval(updateReadout, 100);
    })
    .catch((err) => {
      console.error(err);
      $('#viewer').classList.add('unavailable');
      $('#viewer').textContent = 'Vue 3D indisponible (WebGL ou three.js n’a pas pu être chargé). La simulation rapide reste utilisable.';
      $('#throw-series').disabled = true;
      $('#slow-single').disabled = true;
    });
}

init();
