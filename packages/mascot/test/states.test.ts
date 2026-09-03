/**
 * The state definitions.
 *
 * The runtime has no state-specific code: it reads a definition and draws it.
 * So every guarantee the runtime needs is a property of the data here, and a
 * new state can break the rig without one line of the rig changing.
 */

import { describe, expect, test } from "bun:test";
import type { Point, Segment } from "../src/geometry.ts";
import { LIMIT } from "../src/motion.ts";
import { PARTS, POINTS, type Silhouette } from "../src/shapes.ts";
import { NO_GESTURE, STATE, STATES } from "../src/states/index.ts";
import { boxOf, pointsOf, signature } from "./support.ts";

/** The still silhouette of a state, and every frame of its cycle. */
function silhouettesOf(state: (typeof STATES)[number]): readonly (readonly [string, Silhouette])[] {
  const definition = STATE[state];
  const cycle = definition.cycle?.frames ?? [];
  return [
    [state, definition.silhouette] as const,
    ...cycle.map((frame, i) => [`${state} frame ${i}`, frame] as const),
  ];
}

const EVERY_SILHOUETTE = STATES.flatMap(silhouettesOf);

describe("every silhouette is in the shared form", () => {
  /** One M, then one cubic per point. This is what makes a morph one lerp. */
  const SHARED = `M1${"C3".repeat(POINTS)}`;

  for (const [name, silhouette] of EVERY_SILHOUETTE) {
    test(`${name} is PARTS loops with the shared command list`, () => {
      expect(silhouette.loops.length).toBe(PARTS);
      for (const loop of silhouette.loops) expect(signature(loop)).toBe(SHARED);
    });
  }
});

describe("any state can morph into any other", () => {
  // A blend is one lerp per point, so the command lists have to agree. Check
  // the ordered pairs, not just the set: a morph reads both sides.
  for (const from of STATES) {
    for (const to of STATES) {
      test(`${from} into ${to}`, () => {
        const before = STATE[from].silhouette.loops;
        const after = STATE[to].silhouette.loops;
        expect(after.length).toBe(before.length);
        for (let i = 0; i < before.length; i++) {
          expect(signature(after[i] as readonly Segment[])).toBe(signature(before[i] as readonly Segment[]));
        }
      });
    }
  }
});

describe("the head rides a loop that exists", () => {
  for (const [name, silhouette] of EVERY_SILHOUETTE) {
    test(`${name} points face.rides at one of its own loops`, () => {
      expect(Number.isInteger(silhouette.face.rides)).toBe(true);
      expect(silhouette.face.rides).toBeGreaterThanOrEqual(0);
      expect(silhouette.face.rides).toBeLessThan(silhouette.loops.length);
    });
  }
});

describe("every gesture stays inside its bounds", () => {
  /** Cycles of the state's own clock to walk, and samples in each one. */
  const CYCLES = 3;
  const PER_CYCLE = 240;
  /**
   * A gesture's squash is in units of LIMIT.bodySquash: the runtime multiplies
   * by it and then clamps to it. Anything past a small multiple of 1 would
   * spend its whole travel inside that clamp and read as a hold.
   */
  const SQUASH_UNITS = 2;
  /**
   * A lift is in viewBox units. The tightest measured margin from painted
   * geometry to the tile edge is 57 units, so a lift near that would push the
   * character off the tile.
   */
  const MAX_LIFT = 56;

  for (const state of STATES) {
    const definition = STATE[state];

    test(`${state} holds its bounds across ${CYCLES} cycles of its own period`, () => {
      const seconds = definition.life.period * CYCLES;
      for (let i = 0; i <= PER_CYCLE * CYCLES; i++) {
        const time = (seconds * i) / (PER_CYCLE * CYCLES);
        const phase = (time / definition.life.period) * Math.PI * 2;
        const gesture = definition.gesture(phase, 1);
        const where = `${state} at phase ${phase.toFixed(3)}`;

        expect(gesture.wink, where).toBeGreaterThanOrEqual(0);
        expect(gesture.wink, where).toBeLessThanOrEqual(1);

        expect(gesture.turn, where).toBeGreaterThanOrEqual(-1);
        expect(gesture.turn, where).toBeLessThanOrEqual(1);

        expect(Math.abs(gesture.squash), where).toBeLessThanOrEqual(SQUASH_UNITS);

        expect(gesture.lift, where).toBeGreaterThanOrEqual(0);
        expect(gesture.lift, where).toBeLessThanOrEqual(MAX_LIFT);

        expect(gesture.gaze.x, where).toBeGreaterThanOrEqual(-1);
        expect(gesture.gaze.x, where).toBeLessThanOrEqual(1);
        expect(gesture.gaze.y, where).toBeGreaterThanOrEqual(-1);
        expect(gesture.gaze.y, where).toBeLessThanOrEqual(1);

        expect(gesture.peak, where).toBeGreaterThanOrEqual(-1);
        expect(gesture.peak, where).toBeLessThanOrEqual(1);
        expect(Math.abs(gesture.tilt), where).toBeLessThanOrEqual(LIMIT.bodyLean);

        expect(gesture.loops.length, where).toBe(PARTS);
        for (const loop of gesture.loops) {
          expect(Number.isFinite(loop.shift.x), where).toBe(true);
          expect(Number.isFinite(loop.shift.y), where).toBe(true);
          expect(loop.scale, where).toBeGreaterThan(0);
          expect(loop.scale, where).toBeLessThanOrEqual(2);
        }
      }
    });

    test(`${state} makes no gesture at all at a weight of zero`, () => {
      // A gesture is weighted by the morph. At zero it must be the null
      // gesture, or an arriving shape and the gesture on it fight each other.
      // Compared by value, because a weighted sine gives back a signed zero.
      for (let i = 0; i < 16; i++) {
        const phase = (i / 16) * Math.PI * 2 * CYCLES;
        const gesture = definition.gesture(phase, 0);
        const where = `${state} at phase ${phase.toFixed(3)}`;

        expect(gesture.turn, where).toBeCloseTo(NO_GESTURE.turn, 12);
        expect(gesture.peak, where).toBeCloseTo(NO_GESTURE.peak, 12);
        expect(gesture.tilt, where).toBeCloseTo(NO_GESTURE.tilt, 12);
        expect(gesture.gaze.x, where).toBeCloseTo(NO_GESTURE.gaze.x, 12);
        expect(gesture.gaze.y, where).toBeCloseTo(NO_GESTURE.gaze.y, 12);
        expect(gesture.wink, where).toBeCloseTo(NO_GESTURE.wink, 12);
        expect(gesture.lift, where).toBeCloseTo(NO_GESTURE.lift, 12);
        expect(gesture.squash, where).toBeCloseTo(NO_GESTURE.squash, 12);

        expect(gesture.loops.length, where).toBe(PARTS);
        for (const loop of gesture.loops) {
          expect(loop.shift.x, where).toBeCloseTo(0, 12);
          expect(loop.shift.y, where).toBeCloseTo(0, 12);
          expect(loop.scale, where).toBeCloseTo(1, 12);
        }
      }
    });

    test(`${state} scales its gesture with the weight`, () => {
      // Half the weight has to be less than the whole of it somewhere in the
      // cycle, or the weight is not being read.
      const reach = (weight: number): number => {
        let most = 0;
        for (let i = 0; i <= 120; i++) {
          const gesture = definition.gesture(((i / 120) * Math.PI * 2 * CYCLES), weight);
          most = Math.max(
            most,
            Math.abs(gesture.turn),
            Math.abs(gesture.squash),
            Math.abs(gesture.lift),
            Math.abs(gesture.gaze.x),
            Math.abs(gesture.gaze.y),
            1 - gesture.wink,
            ...gesture.loops.map((loop) => Math.abs(loop.shift.y) + Math.abs(loop.scale - 1)),
          );
        }
        return most;
      };
      const full = reach(1);
      // `loading` says nothing while held: the shapes are its whole life.
      if (full === 0) return;
      expect(reach(0.5)).toBeLessThan(full);
    });
  }
});

describe("every silhouette stays on the tile", () => {
  /**
   * The canvas is 1024 units. The measured margins at rest run from 136 units
   * on the diamond to 190 on the bar, and the README's worst case with the
   * arrival beat, the gesture, and the breath stacked is 57. A floor of 64
   * leaves the tuning free and still catches a shape that grew off the tile.
   */
  const MARGIN = 64;
  const CANVAS = 1024;

  for (const [name, silhouette] of EVERY_SILHOUETTE) {
    test(`${name} keeps ${MARGIN} units of margin at rest`, () => {
      const bounds = boxOf(pointsOf(silhouette.loops));

      expect(bounds.minX, name).toBeGreaterThan(MARGIN);
      expect(bounds.minY, name).toBeGreaterThan(MARGIN);
      expect(bounds.maxX, name).toBeLessThan(CANVAS - MARGIN);
      expect(bounds.maxY, name).toBeLessThan(CANVAS - MARGIN);
    });
  }

  test("the head sits inside the loop it rides", () => {
    for (const [name, silhouette] of EVERY_SILHOUETTE) {
      const ridden = silhouette.loops[silhouette.face.rides] as readonly Segment[];
      const bounds = boxOf(pointsOf([ridden]));
      const eyes: Point = { x: silhouette.face.x, y: silhouette.face.y };

      expect(eyes.x, name).toBeGreaterThan(bounds.minX);
      expect(eyes.x, name).toBeLessThan(bounds.maxX);
      expect(eyes.y, name).toBeGreaterThan(bounds.minY);
      expect(eyes.y, name).toBeLessThan(bounds.maxY);
    }
  });
});

describe("the state table", () => {
  test("STATES lists every key of STATE, once", () => {
    expect([...STATES].map(String).sort()).toEqual(Object.keys(STATE).sort());
    expect(new Set(STATES).size).toBe(STATES.length);
  });

  test("every state declares a period it can be clocked by", () => {
    for (const state of STATES) {
      expect(STATE[state].life.period, state).toBeGreaterThan(0);
    }
  });

  test("a cycling state declares frames and a tick", () => {
    for (const state of STATES) {
      const cycle = STATE[state].cycle;
      if (cycle === undefined) continue;
      expect(cycle.frames.length, state).toBeGreaterThan(1);
      expect(cycle.tick, state).toBeGreaterThan(0);
    }
  });
});
