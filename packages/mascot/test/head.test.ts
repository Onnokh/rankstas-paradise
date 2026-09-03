/**
 * The head as a sphere, and the yaw that turns it.
 *
 * Three claims carry the turn. First, the projection is a rotation: at a yaw
 * of zero it is the identity, so the rig re-emits the artwork, and at any
 * other yaw it moves a point the way a sphere would. Second, the band ring
 * stays a band — clear of the eyes, past the rim on both sides, and a closed
 * strip that does not fold through itself. Third, the knot rides that strip
 * and comes out at the rim, because the tails hang from the knot.
 */

import { describe, expect, test } from "bun:test";
import { ANCHOR, BAND_REST } from "../src/art.ts";
import { flatten, parsePath, type Point } from "../src/geometry.ts";
import {
  HEAD,
  KNOT_ON_STRIP,
  RING,
  RING_REACH,
  RING_SAMPLES,
  RING_SLOPE,
  angleOf,
  bandRing,
  depthOf,
  project,
  ringAt,
  wrapAngle,
  yawWarp,
} from "../src/head.ts";
import { LIMIT, TURN } from "../src/motion.ts";

/** The yaw the rig can reach, in radians. Everything else is inside it. */
const MAX_YAW = (TURN.degrees * Math.PI) / 180;

/** The live yaw range, both ways, at a step small enough to catch a crest. */
const YAWS: readonly number[] = Array.from({ length: 121 }, (_, i) => (MAX_YAW * (i - 60)) / 60);

/** The rim of the head sphere, where a point turns out of sight. */
const RIM = { left: HEAD.axis - HEAD.radius, right: HEAD.axis + HEAD.radius } as const;

/**
 * The two edges of the ring outline that `bandRing` emits.
 *
 * The outline is one M and a run of L: the top edge from left to right, then
 * the bottom edge back again. Both edges carry the same x values, so an index
 * is a place along the strip.
 */
function edgesOf(yaw: number): { top: Point[]; bottom: Point[] } {
  const points = bandRing(yaw).map((segment) => segment.points[0]!);
  const half = points.length / 2;
  return { top: points.slice(0, half), bottom: points.slice(half).reverse() };
}

/** The lowest the edge hangs at that x, or null where the edge does not reach. */
function lowestAt(edge: readonly Point[], x: number): number | null {
  let lowest: number | null = null;
  for (let i = 0; i < edge.length - 1; i++) {
    const a = edge[i]!;
    const b = edge[i + 1]!;
    if ((a.x <= x) !== (b.x <= x)) {
      const y = a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
      if (lowest === null || y > lowest) lowest = y;
    }
  }
  return lowest;
}

describe("angleOf and project", () => {
  test("they are inverse at a yaw of zero, so rest is the artwork", () => {
    // 1e-9 is float noise on an arcsine and a sine of a number near 500.
    for (let i = 0; i <= 100; i++) {
      const x = RIM.left + ((RIM.right - RIM.left) * i) / 100;
      expect(project(angleOf(x), 0)).toBeCloseTo(x, 9);
    }
  });

  test("a point outside the sphere clamps to the rim, and never gives NaN", () => {
    // The wide silhouettes do put points outside the sphere: the diamond
    // reaches x 844 against a rim at 800, and the tile is 1024 across.
    for (const x of [-5000, -1, 0, RIM.left - 44, RIM.right + 44, 1024, 5000]) {
      const angle = angleOf(x);
      expect(Number.isNaN(angle)).toBe(false);
      expect(Math.abs(angle)).toBeLessThanOrEqual(Math.PI / 2);
    }
    expect(angleOf(RIM.left - 1)).toBeCloseTo(-Math.PI / 2, 12);
    expect(angleOf(RIM.right + 1)).toBeCloseTo(Math.PI / 2, 12);
  });

  test("the front of the sphere sweeps across, in the direction of the yaw", () => {
    expect(project(0, 0)).toBeCloseTo(HEAD.axis, 12);
    let last = -Infinity;
    for (const yaw of YAWS) {
      const x = project(0, yaw);
      expect(x).toBeGreaterThan(last);
      last = x;
    }
  });

  test("nothing leaves the span of the sphere, at any angle and any yaw", () => {
    for (const yaw of YAWS) {
      for (let i = 0; i <= 64; i++) {
        const angle = -Math.PI + (2 * Math.PI * i) / 64;
        const x = project(angle, yaw);
        expect(x).toBeGreaterThanOrEqual(RIM.left - 1e-9);
        expect(x).toBeLessThanOrEqual(RIM.right + 1e-9);
      }
    }
  });

  test("the far side compresses and the front opens up", () => {
    // The local scale of the projection is the foreshortening, so a small
    // span comes out cos(angle + yaw) / cos(angle) times as wide.
    const span = 0.02;
    const widthOf = (centre: number, yaw: number): number =>
      project(centre + span, yaw) - project(centre - span, yaw);

    for (const yaw of YAWS) {
      if (yaw === 0) continue;
      // Whatever lands at the far rim is squeezed to nothing.
      const far = Math.sign(yaw) * (Math.PI / 2) - yaw;
      expect(widthOf(far, yaw)).toBeLessThan(widthOf(far, 0));
      // Whatever lands straight ahead is at its widest: nothing beats the front.
      const front = -yaw;
      expect(widthOf(front, yaw)).toBeGreaterThan(widthOf(front, 0));
      expect(widthOf(front, yaw)).toBeGreaterThanOrEqual(widthOf(far, yaw));
    }
  });

  test("a turn to the right compresses the right eye and opens the left one", () => {
    // Measured at a full turn of 45°: the far eye comes out 52.1 units wide
    // against 94 at rest, and the near eye 97.0.
    const width = (centre: number, yaw: number): number =>
      project(angleOf(centre + ANCHOR.eyeRadius), yaw) - project(angleOf(centre - ANCHOR.eyeRadius), yaw);
    const rest = 2 * ANCHOR.eyeRadius;

    expect(width(ANCHOR.eyeRight.x, MAX_YAW)).toBeLessThan(rest);
    expect(width(ANCHOR.eyeLeft.x, MAX_YAW)).toBeGreaterThan(rest);
  });
});

describe("yawWarp", () => {
  const SAMPLES: readonly Point[] = [
    ANCHOR.eyeLeft,
    ANCHOR.eyeRight,
    ANCHOR.knot,
    ANCHOR.browLeft.outer,
    ANCHOR.browRight.outer,
    { x: RIM.left, y: 300 },
    { x: RIM.right, y: 700 },
    { x: 0, y: 0 },
    { x: 1024, y: 1024 },
  ];

  test("at a yaw of zero it hands every point straight back", () => {
    const warp = yawWarp(0);
    // The same object, not a copy: the rig's rest path trusts the identity.
    for (const point of SAMPLES) expect(warp(point)).toBe(point);
  });

  test("it never changes a height", () => {
    for (const yaw of YAWS) {
      const warp = yawWarp(yaw);
      for (const point of SAMPLES) expect(warp(point).y).toBe(point.y);
    }
  });

  test("it keeps every point inside the sphere, whatever it was given", () => {
    // A yaw of zero is the identity and hands a point outside the sphere
    // straight back, which is what the rest path wants.
    for (const yaw of YAWS) {
      if (yaw === 0) continue;
      const warp = yawWarp(yaw);
      for (const point of SAMPLES) {
        const x = warp(point).x;
        expect(Number.isFinite(x)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(RIM.left - 1e-9);
        expect(x).toBeLessThanOrEqual(RIM.right + 1e-9);
      }
    }
  });
});

describe("depthOf", () => {
  test("it is 1 straight ahead, 0 at the rim, and below 0 behind", () => {
    expect(depthOf(0, 0)).toBe(1);
    // cos(π/2) is 6.1e-17 in floating point, not 0, so the rim needs a tolerance.
    expect(depthOf(Math.PI / 2, 0)).toBeCloseTo(0, 15);
    expect(depthOf(-Math.PI / 2, 0)).toBeCloseTo(0, 15);
    expect(depthOf(Math.PI, 0)).toBe(-1);
  });

  test("its sign changes at the rim, which is what puts the tails behind the body", () => {
    // A ten-thousandth of a radian each side of the rim. The rig only reads
    // the sign, so the exact value at the rim itself does not matter.
    const nudge = 1e-4;
    for (const yaw of YAWS) {
      for (const rim of [Math.PI / 2, -Math.PI / 2]) {
        // Toward the front on one rim is away from it on the other.
        const inward = rim > 0 ? -nudge : nudge;
        expect(depthOf(rim + inward - yaw, yaw)).toBeGreaterThan(0);
        expect(depthOf(rim - inward - yaw, yaw)).toBeLessThan(0);
      }
    }
  });

  test("the yaw moves the rim, so the knot goes behind on the way round", () => {
    const knot = angleOf(ANCHOR.knot.x);
    expect(depthOf(knot, 0)).toBeGreaterThan(0);
    // The knot sits at 73.6°, so a turn of 45° away takes it past the rim.
    expect(depthOf(knot, MAX_YAW)).toBeLessThan(0);
    expect(depthOf(knot, -MAX_YAW)).toBeGreaterThan(0);
  });
});

describe("wrapAngle", () => {
  test("it folds any whole turn away", () => {
    for (const angle of [0, 0.5, -0.5, 1.5, -1.5, 3, -3]) {
      for (const turns of [-100, -12, -1, 0, 1, 12, 100]) {
        // 1e-9: a hundred turns is 628 radians, and the fold loses places off
        // the bottom of a double at that size.
        expect(wrapAngle(angle + 2 * Math.PI * turns)).toBeCloseTo(angle, 9);
      }
    }
  });

  test("it always answers inside -π..π", () => {
    for (let i = -2000; i <= 2000; i++) {
      const wrapped = wrapAngle(i / 7);
      expect(wrapped).toBeGreaterThanOrEqual(-Math.PI);
      expect(wrapped).toBeLessThanOrEqual(Math.PI);
    }
  });
});

describe("ringAt", () => {
  test("it is defined at every angle, front or back", () => {
    for (let i = -720; i <= 720; i++) {
      const { top, bottom } = ringAt((i * Math.PI) / 180);
      expect(Number.isFinite(top)).toBe(true);
      expect(Number.isFinite(bottom)).toBe(true);
      expect(bottom).toBeGreaterThan(top);
    }
  });

  test("it folds the back onto the front, so a full turn reads the same ring twice", () => {
    for (let i = 0; i <= 180; i++) {
      const angle = -Math.PI / 2 + (Math.PI * i) / 180;
      const front = ringAt(angle);
      // Behind the rim, the mirror of that angle.
      expect(ringAt(Math.PI - angle).top).toBeCloseTo(front.top, 9);
      expect(ringAt(Math.PI - angle).bottom).toBeCloseTo(front.bottom, 9);
      // And a whole turn later.
      expect(ringAt(angle + 2 * Math.PI).top).toBeCloseTo(front.top, 6);
    }
  });

  test("it is continuous where the halves meet", () => {
    // A ten-thousandth of a radian each side of both rims. Measured, the step
    // is 0; the worst step anywhere on a turn of 20000 samples is 0.04 units.
    const nudge = 1e-4;
    for (const rim of [Math.PI / 2, -Math.PI / 2]) {
      const before = ringAt(rim - nudge);
      const after = ringAt(rim + nudge);
      expect(after.top).toBeCloseTo(before.top, 6);
      expect(after.bottom).toBeCloseTo(before.bottom, 6);
    }
  });

  test("it peaks where the artwork's band peaks", () => {
    let artwork = { x: 0, y: Infinity };
    for (const point of flatten(parsePath(BAND_REST), 24)) {
      if (point.y < artwork.y) artwork = { x: point.x, y: point.y };
    }

    let crest = { angle: 0, top: Infinity };
    for (let i = -2000; i <= 2000; i++) {
      const angle = (Math.PI / 2) * (i / 2000);
      const { top } = ringAt(angle);
      if (top < crest.top) crest = { angle, top };
    }

    // The ring holds 48 samples across the front, which is about 18 units
    // apart at the crest, so half a sample is the most this can resolve.
    // Measured: the crest lands at x 334.7 against the artwork's 342.5.
    expect(project(crest.angle, 0)).toBeCloseTo(artwork.x, -1.5);
    expect(crest.top).toBeCloseTo(artwork.y, -1);
  });

  test("the ring holds one more sample than the count it steps", () => {
    expect(RING.top.length).toBe(RING_SAMPLES + 1);
    expect(RING.bottom.length).toBe(RING_SAMPLES + 1);
    for (let i = 0; i <= RING_SAMPLES; i++) expect(RING.bottom[i]!).toBeGreaterThan(RING.top[i]!);
  });
});

describe("the band ring against the eyes", () => {
  /**
   * The band dropped over the eyes when the head turned, which is what this
   * checks. The eyes are taken at the widest gaze the rig allows, and the
   * whole width of each eye is measured, not only its centre.
   */
  test("the ring's lower edge stays above the eyes at every live yaw", () => {
    let worst = { clearance: Infinity, yaw: 0, x: 0 };

    for (const yaw of YAWS) {
      const { bottom } = edgesOf(yaw);
      for (const eye of [ANCHOR.eyeLeft, ANCHOR.eyeRight]) {
        for (const gazeX of [-LIMIT.gazeX, 0, LIMIT.gazeX]) {
          const centre = project(angleOf(eye.x + gazeX), yaw);
          // The gaze lifts the eye as well, and up is the way toward the band.
          const crown = eye.y - LIMIT.gazeY - ANCHOR.eyeRadius;
          for (let i = -8; i <= 8; i++) {
            const x = centre + (ANCHOR.eyeRadius * i) / 8;
            const edge = lowestAt(bottom, x);
            if (edge === null) continue;
            if (crown - edge < worst.clearance) worst = { clearance: crown - edge, yaw, x };
          }
        }
      }
    }

    // Measured worst case: 42.5 units of clear ink, at a full turn of 45°,
    // under the outer edge of the far eye at x 821.
    expect(worst.clearance).toBeGreaterThan(0);
  });
});

describe("bandRing", () => {
  test("it reaches past the rim by the documented reach, at every yaw", () => {
    // A band that stopped at the head sphere left a wedge of bare ink before
    // the edge of the wider shapes. `bandRing` also steps a few units past
    // the rim before it extends, so the reach measured here is a little more.
    for (const yaw of YAWS) {
      const { top, bottom } = edgesOf(yaw);
      for (const edge of [top, bottom]) {
        expect(RIM.left - edge[0]!.x).toBeGreaterThanOrEqual(RING_REACH);
        expect(edge[edge.length - 1]!.x - RIM.right).toBeGreaterThanOrEqual(RING_REACH);
      }
    }
  });

  test("the slope of the extension stays inside the documented limit", () => {
    // Held to RING_SLOPE so the extension carries on along the strip instead
    // of diving into the face. Measured, both ends reach the limit exactly.
    for (const yaw of YAWS) {
      const { top, bottom } = edgesOf(yaw);
      for (const edge of [top, bottom]) {
        const last = edge.length - 1;
        const head = Math.abs((edge[1]!.y - edge[0]!.y) / (edge[1]!.x - edge[0]!.x));
        const tail = Math.abs((edge[last]!.y - edge[last - 1]!.y) / (edge[last]!.x - edge[last - 1]!.x));
        expect(head).toBeLessThanOrEqual(RING_SLOPE + 1e-9);
        expect(tail).toBeLessThanOrEqual(RING_SLOPE + 1e-9);
      }
    }
  });

  test("it is one closed outline of finite points, at every yaw", () => {
    for (const yaw of YAWS) {
      const segments = bandRing(yaw);
      // Both edges, each the ring's samples with one extension at each end.
      expect(segments.length).toBe(2 * (RING_SAMPLES + 3));
      expect(segments[0]!.cmd).toBe("M");
      for (const segment of segments.slice(1)) expect(segment.cmd).toBe("L");
      for (const segment of segments) {
        expect(segment.points.length).toBe(1);
        expect(Number.isFinite(segment.points[0]!.x)).toBe(true);
        expect(Number.isFinite(segment.points[0]!.y)).toBe(true);
      }
    }
  });

  test("each edge runs left to right and never doubles back on itself", () => {
    for (const yaw of YAWS) {
      const { top, bottom } = edgesOf(yaw);
      for (const edge of [top, bottom]) {
        for (let i = 1; i < edge.length; i++) expect(edge[i]!.x).toBeGreaterThan(edge[i - 1]!.x);
      }
    }
  });

  test("the top edge stays above the bottom edge across everything the mask can paint", () => {
    // The two extensions run out at their own slopes and converge, so past
    // the body the outline does cross: measured, at x 901 on the right and
    // x -180 on the left, at worst. The widest silhouette the rig draws
    // reaches x 844, and the band's mask is that shape inset, so the span
    // below is beyond anything the band can be trimmed to. Within it the
    // narrowest the strip ever gets is 14.2 units.
    const PAINTED = { from: 0, to: RIM.right + 70 };

    for (const yaw of YAWS) {
      const { top, bottom } = edgesOf(yaw);
      for (let i = 0; i < top.length - 1; i++) {
        for (let step = 0; step <= 20; step++) {
          const along = step / 20;
          const x = top[i]!.x + (top[i + 1]!.x - top[i]!.x) * along;
          if (x < PAINTED.from || x > PAINTED.to) continue;
          const above = top[i]!.y + (top[i + 1]!.y - top[i]!.y) * along;
          const below = bottom[i]!.y + (bottom[i + 1]!.y - bottom[i]!.y) * along;
          expect(below).toBeGreaterThan(above);
        }
      }
    }
  });
});

describe("the knot on the band", () => {
  const KNOT_ANGLE = angleOf(ANCHOR.knot.x);

  /** Where the runtime puts the knot at that yaw, and the strip it rides. */
  function knotAt(yaw: number): { knot: Point; strip: { top: number; bottom: number } } {
    const strip = ringAt(KNOT_ANGLE + yaw);
    return {
      knot: { x: project(KNOT_ANGLE, yaw), y: (strip.top + strip.bottom) / 2 + KNOT_ON_STRIP },
      strip,
    };
  }

  test("at rest it sits where the artwork puts it", () => {
    const { knot } = knotAt(0);
    expect(knot.x).toBeCloseTo(ANCHOR.knot.x, 9);
    expect(knot.y).toBeCloseTo(ANCHOR.knot.y, 9);
  });

  test("it stays on the strip through a whole revolution of the band", () => {
    // The tails hang from the knot, so a knot off the strip hangs them from
    // bare ink. The band turns a full circle while thinking, so the whole
    // revolution counts, not only the live yaw range.
    let worst = { margin: Infinity, yaw: 0 };
    for (let i = 0; i < 3600; i++) {
      const yaw = (2 * Math.PI * i) / 3600;
      const { knot, strip } = knotAt(yaw);
      const margin = Math.min(knot.y - strip.top, strip.bottom - knot.y);
      if (margin < worst.margin) worst = { margin, yaw };
    }
    // Measured worst case: 9.9 units below the top edge, at rest.
    expect(worst.margin).toBeGreaterThan(0);
  });

  test("it surfaces at the rim, so its travel spans the whole head", () => {
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 3600; i++) {
      const { knot } = knotAt((2 * Math.PI * i) / 3600);
      if (knot.x < low) low = knot.x;
      if (knot.x > high) high = knot.x;
    }
    // Measured: 620.606 units, which is the sphere's own width. A knot that
    // stopped short would never reach the edge of the body.
    expect(high - low).toBeCloseTo(2 * HEAD.radius, 3);
    expect(low).toBeCloseTo(RIM.left, 3);
    expect(high).toBeCloseTo(RIM.right, 3);
  });

  test("the artwork hangs it above the middle of the strip", () => {
    // Read off the artwork once, so a change to the band moves the knot with
    // it. Negative is up: the knot sits 10.4 units above the centre line.
    expect(KNOT_ON_STRIP).toBeLessThan(0);
    const strip = ringAt(KNOT_ANGLE);
    expect((strip.top + strip.bottom) / 2 + KNOT_ON_STRIP).toBeCloseTo(ANCHOR.knot.y, 9);
  });
});
