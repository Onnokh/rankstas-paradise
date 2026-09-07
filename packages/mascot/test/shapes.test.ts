/**
 * The shapes a silhouette can be made of.
 *
 * Two claims carry the whole rig. First, every shape comes out in the same
 * shared form, or a morph has nothing to blend. Second, the procedural ghost
 * is the artwork, or rest does not look like the brand icon.
 */

import { describe, expect, test } from "bun:test";
import { BODY_REST, FRAME } from "../src/art.ts";
import { flatten, parsePath, type Segment } from "../src/geometry.ts";
import {
  CENTRE,
  GHOST_SPLINE,
  PARTS,
  POINTS,
  box,
  circleLoop,
  dotAt,
  ghostSpline,
  regular,
  roundedPolygonLoop,
  split,
  toSpline,
  whole,
} from "../src/shapes.ts";
import { boxOf, distanceToLoop, onCurve, signature } from "./support.ts";

/** Every shape in the package, built the way the states build it. */
const SHAPES: Record<string, readonly Segment[]> = {
  // idle
  ghost: GHOST_SPLINE,
  // thinking
  circle: toSpline(circleLoop(CENTRE.x, CENTRE.y, FRAME.halfWidth)),
  // loading
  triangle: toSpline(roundedPolygonLoop(regular(3, 400, 0), 96)),
  square: toSpline(roundedPolygonLoop(box(300, 300), 96)),
  bar: toSpline(roundedPolygonLoop(box(176, 320), 176)),
  play: toSpline(roundedPolygonLoop(regular(3, 400, 90), 96)),
  dot: dotAt(CENTRE.x, 513, 84),
  // success
  diamond: toSpline(roundedPolygonLoop(regular(4, 380, 0), 74)),
  // error
  mark: toSpline(
    roundedPolygonLoop(
      [
        { x: CENTRE.x - 96, y: 172 },
        { x: CENTRE.x + 96, y: 172 },
        { x: CENTRE.x + 96, y: 632 },
        { x: CENTRE.x - 96, y: 632 },
      ],
      96,
    ),
    { x: CENTRE.x, y: (172 + 632) / 2 },
  ),
};

describe("the shared form", () => {
  /** One M, then one cubic per point. Anything else cannot blend. */
  const SHARED = `M1${"C3".repeat(POINTS)}`;

  test("every shape splines to the shared form", () => {
    for (const [name, spline] of Object.entries(SHAPES)) {
      expect(spline.length, name).toBe(POINTS + 1);
      expect(signature(spline), name).toBe(SHARED);
    }
  });

  test("every shape carries the same command list as every other", () => {
    const names = Object.keys(SHAPES);
    for (const from of names) {
      for (const to of names) {
        expect(signature(SHAPES[from]!)).toBe(signature(SHAPES[to]!));
      }
    }
  });

  test("a loop is aligned about its own centre, not about the canvas", () => {
    // An off-centre loop that is aligned about the canvas starts wherever
    // happens to face left of the canvas, and that copy picks up a twist.
    const off = dotAt(300, 700, 84);
    expect(off[0]!.points[0]!.x).toBeCloseTo(300 - 84, 6);
    expect(off[0]!.points[0]!.y).toBeCloseTo(700, 6);
  });

  test("every shape starts left of its own centre", () => {
    for (const [name, spline] of Object.entries(SHAPES)) {
      const bounds = boxOf(onCurve(spline));
      const middle = (bounds.minX + bounds.maxX) / 2;
      expect(spline[0]!.points[0]!.x, name).toBeLessThan(middle);
    }
  });
});

describe("ghostSpline", () => {
  /**
   * Half a viewBox unit, from the README: about a seventh of a pixel at a
   * 300 px render, so entering a morph shows no step. Measured today: 0.15.
   */
  const ARTWORK_TOLERANCE = 0.5;
  const artwork = flatten(parsePath(BODY_REST), 48);

  test("at a sweep of zero it reproduces the artwork body path", () => {
    for (const point of onCurve(ghostSpline(0))) {
      expect(distanceToLoop(point, artwork)).toBeLessThan(ARTWORK_TOLERANCE);
    }
  });

  test("the artwork body path is also on the procedural ghost", () => {
    // Both directions, or a ghost that dropped a lobe would still pass.
    const ghost = flatten(ghostSpline(0), 24);
    for (const point of artwork) {
      expect(distanceToLoop(point, ghost)).toBeLessThan(1);
    }
  });

  test("GHOST_SPLINE is the ghost at a sweep of zero", () => {
    expect(GHOST_SPLINE).toEqual(ghostSpline(0));
  });

  describe("a hem sweep re-reads the pattern instead of scaling the body", () => {
    const rest = boxOf(flatten(ghostSpline(0), 16));
    /**
     * Half a unit. The straight sides are held by the dome radius, so the only
     * movement here is the Catmull-Rom overshoot of a resampled corner.
     */
    const HOLD = 0.5;

    test("every sweep keeps the sides and the width", () => {
      for (const sweep of [0.2, -0.35, 0.6, Math.PI / 4, 1]) {
        const where = `a sweep of ${sweep.toFixed(2)}`;
        const turned = boxOf(flatten(ghostSpline(sweep), 16));

        expect(Math.abs(turned.minX - rest.minX), where).toBeLessThan(HOLD);
        expect(Math.abs(turned.maxX - rest.maxX), where).toBeLessThan(HOLD);
        expect(Math.abs(turned.maxX - turned.minX - (rest.maxX - rest.minX)), where).toBeLessThan(HOLD);
      }
    });

    test("the sides sit on the dome radius, whatever the hem is doing", () => {
      for (const sweep of [0, 0.5, -0.5]) {
        const turned = boxOf(flatten(ghostSpline(sweep), 16));
        expect(turned.minX).toBeCloseTo(FRAME.cx - FRAME.halfWidth, 0);
        expect(turned.maxX).toBeCloseTo(FRAME.cx + FRAME.halfWidth, 0);
      }
    });

    test("a sweep does move the hem, so the test above is not vacuous", () => {
      const rested = onCurve(ghostSpline(0));
      const turned = onCurve(ghostSpline(0.6));
      const moved = rested.reduce(
        (most, point, i) => Math.max(most, Math.abs(point.y - turned[i]!.y)),
        0,
      );
      expect(moved).toBeGreaterThan(5);
    });

    test("the crown never moves, because only the skirt turns", () => {
      const rested = boxOf(flatten(ghostSpline(0), 16));
      for (const sweep of [0.3, -0.6, 1]) {
        expect(boxOf(flatten(ghostSpline(sweep), 16)).minY).toBeCloseTo(rested.minY, 1);
      }
    });
  });
});

describe("whole and split", () => {
  test("whole gives PARTS copies of one shape", () => {
    const loops = whole(GHOST_SPLINE);
    expect(loops.length).toBe(PARTS);
    for (const loop of loops) expect(loop).toBe(GHOST_SPLINE);
  });

  test("split pads to PARTS by repeating the last piece", () => {
    const bar = SHAPES.mark!;
    const point = dotAt(CENTRE.x, 792, 78);
    const loops = split([bar, point]);

    expect(loops.length).toBe(PARTS);
    expect(loops[0]).toBe(bar);
    expect(loops[1]).toBe(point);
    expect(loops[2]).toBe(point);
  });

  test("split leaves a set that is already PARTS long alone", () => {
    const pieces = [SHAPES.dot!, SHAPES.diamond!, SHAPES.circle!];
    expect(split(pieces)).toEqual(pieces);
  });
});
