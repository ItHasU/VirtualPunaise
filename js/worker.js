// Web Worker : enchaîne des lancers sans affichage et renvoie les résultats par paquets.
import { makeShape } from './shapes.js';
import { createBody, simulateThrow, makeRng } from './physics.js';

const BATCH = 100;

self.onmessage = (ev) => {
  const { config, throws, seed } = ev.data;
  const shape = makeShape(config);
  const body = createBody(shape);
  const rng = makeRng(seed);
  const index = Object.fromEntries(shape.outcomes.map((o, i) => [o, i]));
  let done = 0;
  while (done < throws) {
    const size = Math.min(BATCH, throws - done);
    const results = new Uint8Array(size);
    for (let i = 0; i < size; i++) results[i] = index[simulateThrow(body, config.physics, rng)];
    done += size;
    self.postMessage({ results, done }, [results.buffer]);
  }
  self.postMessage({ finished: true });
};
