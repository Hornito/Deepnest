/*
 * Nesting orchestration for the browser.
 *
 * Deepnest's desktop build splits this work across a renderer process (the
 * genetic algorithm) and hidden Electron windows (the geometry). The split is
 * a good one, so the browser port keeps it: the GA lives here on the main
 * thread, and candidate evaluation is farmed out to a pool of Web Workers.
 *
 * The GA searches over two things at once - the ORDER parts are inserted, and
 * the ROTATION of each part. Placement itself is deterministic given those, so
 * an "individual" is just (order, rotations) and its fitness is whatever the
 * placement worker reports back.
 */

import { GeometryUtil } from './globals.js';

const WORKER_URL = new URL('nesting/nest-worker.js', document.baseURI).href;

export const DEFAULT_CONFIG = {
  clipperScale: 10000000,
  curveTolerance: 0.3,
  spacing: 0,
  rotations: 4,
  populationSize: 10,
  mutationRate: 10,
  useHoles: false,
  exploreConcave: false,
};

/* ------------------------------------------------------------------ *
 * Genetic algorithm
 * ------------------------------------------------------------------ */

class GeneticAlgorithm {
  constructor(adam, bin, config) {
    this.config = config;
    this.binBounds = GeometryUtil.getPolygonBounds(bin);

    const angles = adam.map((part) => this.randomAngle(part));

    this.population = [{ placement: adam, rotation: angles }];

    while (this.population.length < config.populationSize) {
      this.population.push(this.mutate(this.population[0]));
    }
  }

  // Pick a rotation the part can actually use. Angles that make the part too
  // big for the sheet are skipped, so the GA does not waste generations
  // discovering that a 2m part cannot go sideways on a 1m sheet.
  randomAngle(part) {
    const rotations = Math.max(this.config.rotations, 1);
    const angleList = [];
    for (let i = 0; i < rotations; i++) {
      angleList.push(i * (360 / rotations));
    }

    for (let i = angleList.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [angleList[i], angleList[j]] = [angleList[j], angleList[i]];
    }

    for (const angle of angleList) {
      const rotated = GeometryUtil.rotatePolygon(part, angle);
      if (
        rotated.width < this.binBounds.width &&
        rotated.height < this.binBounds.height
      ) {
        return angle;
      }
    }

    return 0;
  }

  mutate(individual) {
    const clone = {
      placement: individual.placement.slice(0),
      rotation: individual.rotation.slice(0),
    };

    for (let i = 0; i < clone.placement.length; i++) {
      if (Math.random() < 0.01 * this.config.mutationRate) {
        // Swap with the next part: a small, local reordering.
        const j = i + 1;
        if (j < clone.placement.length) {
          const temp = clone.placement[i];
          clone.placement[i] = clone.placement[j];
          clone.placement[j] = temp;
        }
      }

      if (Math.random() < 0.01 * this.config.mutationRate) {
        clone.rotation[i] = this.randomAngle(clone.placement[i]);
      }
    }

    return clone;
  }

  // Single-point crossover over the insertion order.
  //
  // Note: upstream svgnest.js computes the cut point from `male.length`, but
  // `male` is an individual object with no `length`, so the expression is NaN
  // and slice(0, NaN) returns an empty array. That silently reduces crossover
  // to "copy the female", losing half the search. Using the placement length
  // is what was intended.
  mate(male, female) {
    const cutpoint = Math.round(
      Math.min(Math.max(Math.random(), 0.1), 0.9) * (male.placement.length - 1)
    );

    const gene1 = male.placement.slice(0, cutpoint);
    const rot1 = male.rotation.slice(0, cutpoint);

    const gene2 = female.placement.slice(0, cutpoint);
    const rot2 = female.rotation.slice(0, cutpoint);

    const contains = (gene, id) => gene.some((g) => g.id === id);

    for (let i = 0; i < female.placement.length; i++) {
      if (!contains(gene1, female.placement[i].id)) {
        gene1.push(female.placement[i]);
        rot1.push(female.rotation[i]);
      }
    }

    for (let i = 0; i < male.placement.length; i++) {
      if (!contains(gene2, male.placement[i].id)) {
        gene2.push(male.placement[i]);
        rot2.push(male.rotation[i]);
      }
    }

    return [
      { placement: gene1, rotation: rot1 },
      { placement: gene2, rotation: rot2 },
    ];
  }

  generation() {
    // Lower fitness is better.
    this.population.sort((a, b) => a.fitness - b.fitness);

    // Elitism: the best individual survives untouched.
    const newpopulation = [this.population[0]];

    while (newpopulation.length < this.population.length) {
      const male = this.randomWeightedIndividual();
      const female = this.randomWeightedIndividual(male);
      const children = this.mate(male, female);

      newpopulation.push(this.mutate(children[0]));
      if (newpopulation.length < this.population.length) {
        newpopulation.push(this.mutate(children[1]));
      }
    }

    this.population = newpopulation;
  }

  // Weighted toward the front of the (sorted) population, so fitter
  // individuals mate more often without the search collapsing onto one.
  randomWeightedIndividual(exclude) {
    const pop = this.population.slice(0);

    if (exclude && pop.indexOf(exclude) >= 0) {
      pop.splice(pop.indexOf(exclude), 1);
    }

    if (pop.length === 0) {
      return this.population[0];
    }

    const rand = Math.random();
    let lower = 0;
    const weight = 1 / pop.length;
    let upper = weight;

    for (let i = 0; i < pop.length; i++) {
      if (rand > lower && rand < upper) {
        return pop[i];
      }
      lower = upper;
      upper += 2 * weight * ((pop.length - i) / pop.length);
    }

    return pop[0];
  }
}

/* ------------------------------------------------------------------ *
 * Worker pool
 * ------------------------------------------------------------------ */

class WorkerPool {
  constructor(size) {
    this.size = Math.max(1, size);
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.nextJob = 0;
    this.onProgress = null;
  }

  spawn() {
    for (let i = 0; i < this.size; i++) {
      const worker = new Worker(WORKER_URL);
      worker.onmessage = (event) => this.handle(worker, event.data);
      worker.onerror = (event) => {
        // A worker that fails to boot at all (bad URL, syntax error) would
        // otherwise hang every job assigned to it.
        this.failAll(
          new Error(
            `Nesting worker failed to start: ${event.message || 'unknown error'}`
          )
        );
      };
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  handle(worker, data) {
    if (data.type === 'progress') {
      if (this.onProgress) {
        this.onProgress(data.index, data.progress);
      }
      return;
    }

    const job = this.pending.get(data.index);
    if (!job) {
      return;
    }
    this.pending.delete(data.index);
    this.idle.push(worker);

    if (data.type === 'error') {
      job.reject(new Error(data.message));
    } else {
      job.resolve(data.placement);
    }

    this.drain();
  }

  failAll(err) {
    for (const job of this.pending.values()) {
      job.reject(err);
    }
    this.pending.clear();
    for (const job of this.queue) {
      job.reject(err);
    }
    this.queue.length = 0;
  }

  run(payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const job = this.queue.shift();
      const worker = this.idle.pop();
      const index = this.nextJob++;

      this.pending.set(index, job);
      worker.postMessage({ type: 'nest', index, ...job.payload });
    }
  }

  clearCaches() {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'clear-cache' });
    }
  }

  terminate() {
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pending.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Nester
 * ------------------------------------------------------------------ */

export class Nester {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    this.onResult = options.onResult || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.onError = options.onError || (() => {});

    this.running = false;
    this.pool = null;
    this.ga = null;
    this.best = null;
    this.generations = 0;
    this.evaluations = 0;
  }

  /*
   * parts:  [{ id, source, quantity, polygon, children }]
   * sheet:  polygon for one sheet (rectangles, from the material library)
   */
  start(parts, sheet) {
    if (this.running) {
      return;
    }

    // Expand quantities into individual placeable instances. The GA orders
    // instances, so two of the same part are two entries with a shared source.
    //
    // Each instance gets its own id because the placement worker uses ids to
    // tell placed parts apart. That id is NOT the caller's part id, so keep a
    // map back to it: results are reported in instance ids, and the caller can
    // only draw or export a placement if it can find the part it came from.
    const placelist = [];
    this.sourceOfInstance = new Map();

    for (const part of parts) {
      const quantity = Math.max(1, part.quantity || 1);
      const source = part.source !== undefined ? part.source : part.id;

      for (let i = 0; i < quantity; i++) {
        const instance = part.polygon.slice(0);
        instance.id = placelist.length;
        instance.source = source;
        instance.children = part.children || [];
        this.sourceOfInstance.set(instance.id, source);
        placelist.push(instance);
      }
    }

    if (placelist.length === 0) {
      this.onError(new Error('Add at least one part before nesting.'));
      return;
    }

    if (!sheet || sheet.length < 3) {
      this.onError(new Error('Select a material and sheet size before nesting.'));
      return;
    }

    this.running = true;
    this.best = null;
    this.generations = 0;
    this.evaluations = 0;

    this.sheet = sheet;
    this.ga = new GeneticAlgorithm(placelist, sheet, this.config);

    // One worker per core, minus one so the UI thread keeps a core to render
    // on. Capped because each worker holds its own NFP cache.
    const cores = navigator.hardwareConcurrency || 4;
    this.pool = new WorkerPool(Math.min(Math.max(cores - 1, 1), 8));
    this.pool.onProgress = () => {};
    this.pool.spawn();

    this.loop();
  }

  async loop() {
    while (this.running) {
      // Evaluate every individual that has no fitness yet, in parallel.
      const unevaluated = this.ga.population.filter(
        (ind) => ind.fitness === undefined
      );

      if (unevaluated.length === 0) {
        this.ga.generation();
        this.generations++;
        continue;
      }

      let results;
      try {
        results = await Promise.all(
          unevaluated.map((individual) =>
            this.pool.run({
              individual: {
                placement: individual.placement.map((p) => serialize(p)),
                rotation: individual.rotation,
              },
              sheets: [serialize(this.sheet)],
              config: this.config,
            })
          )
        );
      } catch (err) {
        if (this.running) {
          this.onError(err);
          this.stop();
        }
        return;
      }

      if (!this.running) {
        return;
      }

      for (let i = 0; i < unevaluated.length; i++) {
        const individual = unevaluated[i];
        const placement = results[i];

        if (!placement) {
          // Nothing could be placed - treat as maximally unfit rather than
          // letting `undefined` poison the sort.
          individual.fitness = Number.MAX_VALUE;
          continue;
        }

        individual.fitness = placement.fitness;
        this.evaluations++;

        if (this.best === null || placement.fitness < this.best.fitness) {
          this.annotateSources(placement);
          this.best = placement;
          this.onResult(placement, {
            generations: this.generations,
            evaluations: this.evaluations,
          });
        }
      }

      this.onProgress({
        generations: this.generations,
        evaluations: this.evaluations,
        best: this.best ? this.best.fitness : null,
      });

      // Yield to the event loop so the UI can paint between generations.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  /*
   * Stamp each placement with the part it came from.
   *
   * The placement worker reports the instance id it was given and nothing
   * else, so without this the caller sees positions it cannot attribute to a
   * part - and silently draws only the instances whose ids happen to collide
   * with real part ids.
   */
  annotateSources(placement) {
    for (const sheet of placement.placements) {
      for (const entry of sheet) {
        entry.source = this.sourceOfInstance.get(entry.id);
      }
    }
  }

  stop() {
    this.running = false;
    if (this.pool) {
      this.pool.terminate();
      this.pool = null;
    }
  }
}

/*
 * Prepare a polygon for the trip to a worker.
 *
 * Throughout the nesting core a polygon is an ARRAY of points that also
 * carries id/source/rotation/children as extra properties. That shape does not
 * survive structured clone: postMessage copies an array's indexed elements and
 * drops every other own property, so the far side would receive the points but
 * lose the identity - and the worker keys its entire NFP cache off `source`.
 *
 * The desktop app works around this by shipping parallel `ids`/`sources`/
 * `children` arrays alongside the placements. An explicit object is the same
 * fix without the bookkeeping, so that is what crosses the boundary; the
 * worker rebuilds the array-with-properties form the geometry code expects.
 */
function serialize(polygon) {
  return {
    points: polygon.map((p) => ({ x: p.x, y: p.y })),
    id: polygon.id,
    source: polygon.source,
    rotation: polygon.rotation,
    children: (polygon.children || []).map((child) => serialize(child)),
  };
}
