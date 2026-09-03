/**
 * The character deformation field.
 *
 * One function moves every point of every part in the same frame, so the
 * headband cannot slide off the head. At rest it has to be the identity: the
 * rig has a fast path that trusts that, and re-emits the artwork itself.
 */

import { describe, expect, test } from "bun:test";
import { FRAME, HEM_STOPS } from "../src/art.ts";
import { characterField, isRest, localScale, type Deformation } from "../src/deform.ts";
import type { Point } from "../src/geometry.ts";
import { HEM_SPRING, SILHOUETTE_GAIN } from "../src/motion.ts";

/** The field doing nothing. */
const REST: Deformation = {
  height: 0,
  width: 0,
  hem: 0,
  peak: 0,
  tilt: 0,
  squash: 0,
  trail: [0, 0, 0, 0, 0],
  ripple: [0, 0, 0, 0, 0],
};

/** A grid over the canvas, plus the landmarks the field measures against. */
const SAMPLES: readonly Point[] = (() => {
  const out: Point[] = [];
  for (let x = 0; x <= 1024; x += 64) for (let y = 0; y <= 1024; y += 64) out.push({ x, y });
  out.push(
    { x: FRAME.cx, y: FRAME.top },
    { x: FRAME.cx, y: FRAME.shoulder },
    { x: FRAME.cx, y: FRAME.bottom },
    { x: FRAME.cx - FRAME.halfWidth, y: FRAME.hemBaseline },
    { x: FRAME.cx + FRAME.halfWidth, y: FRAME.hemBaseline },
  );
  return out;
})();

/** The furthest a field moves any of the sample points. */
function worstMove(field: (point: Point) => Point): number {
  let worst = 0;
  for (const at of SAMPLES) {
    const moved = field(at);
    worst = Math.max(worst, Math.hypot(moved.x - at.x, moved.y - at.y));
  }
  return worst;
}

describe("the field at rest", () => {
  test("an all-zero deformation is the identity", () => {
    // Not "small": the resting fast path re-emits the artwork, so this has to
    // be exact to the last bit the arithmetic can hold.
    expect(worstMove(characterField(REST))).toBeLessThan(1e-9);
  });

  test("isRest agrees that an all-zero deformation is the identity", () => {
    expect(isRest(REST)).toBe(true);
  });

  test("everything isRest calls rest moves no point by a quarter of a unit", () => {
    // isRest has a threshold per channel. Just inside every one of them the
    // field still has to be too small to see. Measured worst case: 0.19.
    const nearly: Deformation = {
      height: 0.0009,
      width: -0.0009,
      hem: 0.0009,
      peak: -0.0009,
      tilt: 0.0009,
      squash: 0.00009,
      trail: [0.009, -0.009, 0.009, -0.009, 0.009],
      ripple: [-0.009, 0.009, -0.009, 0.009, -0.009],
    };
    expect(isRest(nearly)).toBe(true);
    expect(worstMove(characterField(nearly))).toBeLessThan(0.25);
  });

  test("isRest refuses a deformation that does move the shape", () => {
    const channels: readonly Deformation[] = [
      { ...REST, height: 0.01 },
      { ...REST, width: 0.01 },
      { ...REST, hem: 0.01 },
      { ...REST, peak: 0.01 },
      { ...REST, tilt: 0.01 },
      { ...REST, squash: 0.001 },
      { ...REST, trail: [0, 0, 2, 0, 0] },
      { ...REST, ripple: [0, 0, 2, 0, 0] },
    ];
    for (const channel of channels) {
      expect(isRest(channel)).toBe(false);
      expect(worstMove(characterField(channel))).toBeGreaterThan(0);
    }
  });
});

describe("the hem field", () => {
  test("there is one hem spring for every hem stop", () => {
    // The field reads the trail and the ripple with `sampleField(HEM_STOPS,
    // …)`. A shorter list gives back `undefined` and the shape goes to NaN.
    expect(HEM_SPRING.length).toBe(HEM_STOPS.length);
    expect(REST.trail.length).toBe(HEM_STOPS.length);
    expect(REST.ripple.length).toBe(HEM_STOPS.length);
  });

  test("the hem stops run left to right across the body", () => {
    for (let i = 1; i < HEM_STOPS.length; i++) {
      expect(HEM_STOPS[i]!).toBeGreaterThan(HEM_STOPS[i - 1]!);
    }
    expect(HEM_STOPS[0]).toBeCloseTo(FRAME.cx - FRAME.halfWidth, 2);
    expect(HEM_STOPS[HEM_STOPS.length - 1]).toBeCloseTo(FRAME.cx + FRAME.halfWidth, 2);
  });

  test("the trail moves the free hem and leaves the crown alone", () => {
    const field = characterField({ ...REST, trail: [10, 10, 10, 10, 10] });
    // The crown is above `hemFlow.from`, so the lag does not reach it at all.
    expect(field({ x: FRAME.cx, y: FRAME.top }).x).toBeCloseTo(FRAME.cx, 6);
    expect(field({ x: FRAME.cx, y: FRAME.hemFlow.from }).x).toBeCloseTo(FRAME.cx, 6);
    // At `hemFlow.to` the lag applies in full.
    expect(field({ x: FRAME.cx, y: FRAME.hemFlow.to }).x - FRAME.cx).toBeCloseTo(10, 6);
  });
});

describe("height", () => {
  test("the feet are the fixed point, so the character grows upward", () => {
    for (const height of [1, 0.4, -0.4, -1]) {
      const field = characterField({ ...REST, height });
      const feet = field({ x: FRAME.cx, y: FRAME.bottom });
      expect(feet.y).toBeCloseTo(FRAME.bottom, 9);
      expect(feet.x).toBeCloseTo(FRAME.cx, 9);
    }
  });

  test("a full height takes the crown up by the whole gain", () => {
    const reach = FRAME.bottom - FRAME.top;
    const up = characterField({ ...REST, height: 1 })({ x: FRAME.cx, y: FRAME.top });
    expect(FRAME.top - up.y).toBeCloseTo(SILHOUETTE_GAIN.height * reach, 6);

    const down = characterField({ ...REST, height: -1 })({ x: FRAME.cx, y: FRAME.top });
    expect(down.y - FRAME.top).toBeCloseTo(SILHOUETTE_GAIN.height * reach, 6);
  });

  test("height does not move a point sideways", () => {
    const field = characterField({ ...REST, height: 1 });
    for (const at of SAMPLES) expect(field(at).x).toBeCloseTo(at.x, 9);
  });
});

describe("width", () => {
  const offset = 100;
  const field = characterField({ ...REST, width: 1 });
  const reachAt = (y: number): number => (field({ x: FRAME.cx + offset, y }).x - FRAME.cx) / offset;

  test("it is weighted toward the base, so widening reads as planting itself", () => {
    expect(reachAt(FRAME.bottom)).toBeGreaterThan(reachAt(FRAME.top));
  });

  test("the base takes the whole gain and the crown takes widthBase of it", () => {
    expect(reachAt(FRAME.bottom)).toBeCloseTo(1 + SILHOUETTE_GAIN.width, 9);
    expect(reachAt(FRAME.top)).toBeCloseTo(1 + SILHOUETTE_GAIN.width * SILHOUETTE_GAIN.widthBase, 9);
  });

  test("the body axis holds still, so the character does not drift sideways", () => {
    for (const y of [FRAME.top, FRAME.shoulder, FRAME.bottom]) {
      expect(field({ x: FRAME.cx, y }).x).toBeCloseTo(FRAME.cx, 9);
    }
  });
});

describe("localScale", () => {
  test("it recovers a known scale factor from a synthetic field", () => {
    for (const factor of [0.6, 1, 1.25, 2]) {
      const synthetic = (point: Point): Point => ({
        x: 200 + (point.x - 200) * factor,
        y: 800 + (point.y - 800) * factor,
      });
      const probe = localScale(synthetic, { x: 470, y: 560 });
      expect(probe.sx).toBeCloseTo(factor, 9);
      expect(probe.sy).toBeCloseTo(factor, 9);
      expect(probe.centre).toEqual(synthetic({ x: 470, y: 560 }));
    }
  });

  test("it recovers separate scales on the two axes", () => {
    const synthetic = (point: Point): Point => ({ x: point.x * 1.5, y: point.y * 0.5 });
    const probe = localScale(synthetic, { x: 400, y: 400 });
    expect(probe.sx).toBeCloseTo(1.5, 9);
    expect(probe.sy).toBeCloseTo(0.5, 9);
  });

  test("the resting field scales nothing", () => {
    const probe = localScale(characterField(REST), { x: 470, y: 560 });
    expect(probe.sx).toBeCloseTo(1, 9);
    expect(probe.sy).toBeCloseTo(1, 9);
  });

  test("it reads the height gain off the real field", () => {
    const probe = localScale(characterField({ ...REST, height: 1 }), { x: FRAME.cx, y: 500 });
    expect(probe.sy).toBeCloseTo(1 + SILHOUETTE_GAIN.height, 9);
  });
});
