/**
 * The algebra of the three-loop silhouette.
 *
 * Every claim here used to need a browser, because the layer it tests sat in
 * the runtime, and every one of them is a defect that reached the screen: a
 * band spilling over the black outline, a body swirling round itself through a
 * change that only moved it, and a mascot built straight into a state drawing
 * the plain ghost instead of its own shape.
 *
 * The field is left out on purpose. It has its own suite in `deform.test.ts`,
 * and at rest it is the identity, so the mask claims below are about the loops
 * themselves — which is where the anchor choice is decided.
 */

import { describe, expect, test } from "bun:test";
import { ANCHOR, BAND_INSET } from "../src/art.ts";
import { flatten, lerpPath, rotateSpline, type Point, type Segment } from "../src/geometry.ts";
import { bandRing } from "../src/head.ts";
import {
  bandMaskLoop,
  blendFace,
  centreOf,
  faceMap,
  ghostLoopsOf,
  insetLoop,
  knotMap,
  moveLoop,
  offsetBetween,
  perLoop,
  rideFace,
  sameLoop,
  translateLoop,
  twinsOf,
  type LoopMove,
} from "../src/loops.ts";
import { MORPH_TWIST, TURN } from "../src/motion.ts";
import {
  CENTRE,
  GHOST_FACE,
  GHOST_SPLINE,
  PARTS,
  POINTS,
  circleLoop,
  dotAt,
  ghostSpline,
  roundedPolygonLoop,
  toSpline,
  whole,
  type FaceLayout,
  type Silhouette,
} from "../src/shapes.ts";
import { NO_GESTURE, STATE, STATES } from "../src/states/index.ts";
import { boxOf, onCurve } from "./support.ts";

const HELD: LoopMove = { shift: { x: 0, y: 0 }, scale: 1 };

/** Whether a point is inside a closed polyline. Crossings to the left of it. */
function inside(point: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const spans = a.y > point.y !== b.y > point.y;
    if (spans && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
  }
  return hit;
}

/** How many sampled points of `mask` are not inside `body`. The whole claim. */
function outsideOf(mask: readonly Segment[], body: readonly Segment[], perSegment = 2): number {
  const outline = flatten(body, 4);
  return flatten(mask, perSegment).filter((point) => !inside(point, outline)).length;
}

/** How many of the shared points of `mask` escape `body`. Comparable to the README's counts. */
function pointsOutside(mask: readonly Segment[], body: readonly Segment[]): number {
  const outline = flatten(body, 6);
  return onCurve(mask).filter((point) => !inside(point, outline)).length;
}

/** The mask of a silhouette, loop by loop, exactly as `draw` derives it. */
function maskOf(loops: readonly (readonly Segment[])[], face: FaceLayout): readonly Segment[][] {
  const anchor = { x: face.x, y: face.y };
  return loops.map((loop, i) => bandMaskLoop(loop, i, loops, face.rides, anchor));
}

/**
 * The silhouette a state departs from and arrives at while motion is allowed.
 *
 * A cycling state never holds its own still shape then: `setState` takes it
 * straight to the first frame of the cycle. The still shape is only reached
 * under reduced motion, which settles the springs in place and draws no
 * intermediate at all.
 */
function morphShapeOf(state: (typeof STATES)[number]): Silhouette {
  const definition = STATE[state];
  return definition.cycle?.frames[0] ?? definition.silhouette;
}

describe("the band mask nests inside the body", () => {
  // A mask and a silhouette are different shapes that only nest at the two
  // ends of a morph, which is why the mask is derived from the shape just
  // drawn rather than blended alongside it. A mask point outside the body is
  // the band spilling over the black outline, which is what the user saw.

  const silhouettes: (readonly [string, Silhouette])[] = STATES.flatMap((state) => {
    const definition = STATE[state];
    return [
      [state, definition.silhouette] as const,
      ...(definition.cycle?.frames ?? []).map((frame, i) => [`${state} frame ${i}`, frame] as const),
    ];
  });

  for (const [name, silhouette] of silhouettes) {
    test(`${name} holds its mask inside every loop`, () => {
      const masks = maskOf(silhouette.loops, silhouette.face);
      for (let i = 0; i < masks.length; i++) {
        expect(outsideOf(masks[i]!, silhouette.loops[i]!), `${name} loop ${i}`).toBe(0);
      }
    });
  }

  /**
   * Mid-morph is where a blended mask used to fail, so this is the test that
   * matters. The morph is reproduced the way `beginMorph` builds it: the
   * target's start point is offset by `MORPH_TWIST.offset` unless the loop
   * keeps its shape, the swing flips the offset every change, and the face
   * blends with the loops.
   */
  const TWIST = Math.round(POINTS * MORPH_TWIST.offset);

  for (const from of STATES) {
    for (const to of STATES) {
      test(`${from} into ${to} holds its mask inside every loop throughout`, () => {
        const a = morphShapeOf(from);
        const b = morphShapeOf(to);
        for (const swing of [1, -1]) {
          const target = b.loops.map((loop, i) =>
            sameLoop(a.loops[i]!, loop) ? loop : rotateSpline(loop, TWIST * swing),
          );
          for (const t of [0.15, 0.5, 0.85]) {
            const loops = target.map((loop, i) => lerpPath(a.loops[i]!, loop, t));
            const face = blendFace(a.face, b.face, t);
            const masks = maskOf(loops, face);
            for (let i = 0; i < masks.length; i++) {
              expect(outsideOf(masks[i]!, loops[i]!), `swing ${swing}, t ${t}, loop ${i}`).toBe(0);
            }
          }
        }
      });
    }
  }

  /**
   * Why a copy has to sit in the same place to share the head's anchor.
   *
   * `loading`'s still shape is three separate dots and the head rides the
   * middle one. The two outer dots are the middle dot moved 262 units to each
   * side, so a rule that recognised a copy by shape alone sent them to the
   * head anchor and dragged their masks off their own edges. This holds the
   * counterfactual, so the rule cannot quietly loosen again.
   */
  test("a copy that has been moved insets about its own centre", () => {
    const { loops, face } = STATE.loading.silhouette;
    const head = { x: face.x, y: face.y };

    // The rule as it stands: every dot nests.
    const masks = maskOf(loops, face);
    for (let i = 0; i < masks.length; i++) {
      expect(pointsOutside(masks[i]!, loops[i]!), `dot ${i}`).toBe(0);
    }

    // What insetting an outer dot toward the head would have cost.
    for (const i of [0, 2]) {
      expect(pointsOutside(insetLoop(loops[i]!, head), loops[i]!), `dot ${i} at the head`).toBe(55);
    }
  });

  /** The band, placed and scaled by a layout, as the strip that gets painted. */
  const bandBoxOf = (face: FaceLayout) => boxOf(flatten(bandRing(0), 4).map(faceMap(face)));

  /**
   * The band is scaled with the head, so on the ellipsis the strip stays on
   * the middle dot and stops short of both outer ones. That is a second line
   * of defence behind the anchor rule, and it is a narrow miss — measured
   * today, 15 units of clear space on the right — so it is worth pinning.
   */
  test("the band stops short of the ellipsis's outer dots", () => {
    const { loops, face } = STATE.loading.silhouette;
    const band = bandBoxOf(face);
    const left = boxOf(onCurve(loops[0]!));
    const right = boxOf(onCurve(loops[2]!));

    expect(band.minX).toBeGreaterThan(left.maxX);
    expect(band.maxX).toBeLessThan(right.minX);
  });

  /**
   * Leaving the ellipsis is where the old rule actually showed.
   *
   * Restoring motion while `loading` is held morphs the ellipsis into the
   * first frame of the cycle, and that morph *is* drawn frame by frame. By
   * then the band has grown enough to paint the ground an escaping mask
   * covers, so the held shape's clearance no longer protects anything. This
   * walks the whole morph and asks for no spill at all.
   */
  test("leaving the ellipsis spills nothing", () => {
    const still = STATE.loading.silhouette;
    const first = STATE.loading.cycle!.frames[0]!;
    const target = first.loops.map((loop, i) =>
      sameLoop(still.loops[i]!, loop) ? loop : rotateSpline(loop, TWIST),
    );
    for (const t of [0.05, 0.15, 0.3, 0.5, 0.7, 0.9]) {
      const loops = target.map((loop, i) => lerpPath(still.loops[i]!, loop, t));
      const face = blendFace(still.face, first.face, t);
      const masks = maskOf(loops, face);
      for (let i = 0; i < masks.length; i++) {
        expect(outsideOf(masks[i]!, loops[i]!), `t ${t}, loop ${i}`).toBe(0);
      }
    }
  });
});

describe("the anchor choice matters", () => {
  /**
   * The README's first measured claim: a concave loop does not nest inside
   * itself when it is scaled about its bounding box, but it does nest about a
   * point in the thick of the ink, where the head is.
   *
   * No live state is concave enough to show it — the ghost is the only concave
   * silhouette and it nests about either point — so the shape here is a check
   * mark, built with the rig's own builder the way a state builds its shape.
   * The README measured 12 of 160 mask points outside about the box centre, on
   * a check mark the rig no longer has and at a different point count.
   */
  const CHECK = toSpline(
    roundedPolygonLoop(
      [
        { x: 300, y: 470 },
        { x: 430, y: 600 },
        { x: 690, y: 300 },
        { x: 760, y: 370 },
        { x: 430, y: 740 },
        { x: 240, y: 540 },
      ],
      40,
    ),
  );
  /** In the thick of the check's lower bend, where a face would sit. */
  const CHECK_FACE: Point = { x: 370, y: 670 };

  test("a concave loop escapes itself about its box centre", () => {
    expect(pointsOutside(insetLoop(CHECK, centreOf(CHECK)), CHECK)).toBe(18);
  });

  test("the same loop about the head anchor escapes nowhere", () => {
    expect(inside(CHECK_FACE, flatten(CHECK, 6))).toBe(true);
    expect(pointsOutside(insetLoop(CHECK, CHECK_FACE), CHECK)).toBe(0);
  });

  test("the ghost nests about either point, so it is not the shape that shows this", () => {
    const head = { x: GHOST_FACE.x, y: GHOST_FACE.y };
    expect(pointsOutside(insetLoop(GHOST_SPLINE, centreOf(GHOST_SPLINE)), GHOST_SPLINE)).toBe(0);
    expect(pointsOutside(insetLoop(GHOST_SPLINE, head), GHOST_SPLINE)).toBe(0);
  });

  /**
   * The README's second measured claim: each loop of a split shape insets
   * about its own centre, because a dot that sits off to one side is dragged
   * out past its own edge when it insets toward the canvas centre. The README
   * measured 36 of 96 mask points; the exclamation's dot, at the point count
   * the rig now uses, gives 57 of 128.
   */
  test("a split shape's off-centre dot escapes about the canvas centre", () => {
    const dot = STATE.error.silhouette.loops[1]!;
    expect(pointsOutside(insetLoop(dot, CENTRE), dot)).toBe(57);
    expect(pointsOutside(insetLoop(dot, centreOf(dot)), dot)).toBe(0);
  });

  test("the piece the canvas centre sits in does not escape, so the drag is the cause", () => {
    // The bar straddles the canvas centre, so insetting it there is almost
    // insetting it about its own centre, and nothing leaves.
    const bar = STATE.error.silhouette.loops[0]!;
    expect(pointsOutside(insetLoop(bar, CENTRE), bar)).toBe(0);
  });

  test("the inset is BAND_INSET about the anchor and nothing else", () => {
    const dot = dotAt(300, 700, 84);
    const about: Point = { x: 120, y: 200 };
    const moved = insetLoop(dot, about);
    const before = onCurve(dot);
    onCurve(moved).forEach((point, i) => {
      expect(point.x).toBeCloseTo(about.x + (before[i]!.x - about.x) * BAND_INSET, 9);
      expect(point.y).toBeCloseTo(about.y + (before[i]!.y - about.y) * BAND_INSET, 9);
    });
  });
});

describe("offsetBetween and sameLoop", () => {
  // This is what stops the ghost's body from swirling round itself during a
  // change that only moves it: a loop that keeps its shape gets no twist.
  const circle = toSpline(circleLoop(CENTRE.x, CENTRE.y, 300));

  test("a loop is the same shape as itself, at no offset", () => {
    expect(offsetBetween(GHOST_SPLINE, GHOST_SPLINE)).toEqual({ dx: 0, dy: 0 });
    expect(sameLoop(GHOST_SPLINE, GHOST_SPLINE)).toBe(true);
  });

  test("a translated copy is the same shape, and reports the translation", () => {
    const moved = translateLoop(GHOST_SPLINE, 40, -25);
    expect(offsetBetween(GHOST_SPLINE, moved)).toEqual({ dx: 40, dy: -25 });
    // Both ways round, and back again.
    expect(offsetBetween(moved, GHOST_SPLINE)).toEqual({ dx: -40, dy: 25 });
  });

  test("a different shape reports null", () => {
    expect(offsetBetween(GHOST_SPLINE, circle)).toBeNull();
    expect(sameLoop(GHOST_SPLINE, circle)).toBe(false);
  });

  test("loops of different topology are never the same shape", () => {
    expect(offsetBetween(GHOST_SPLINE, GHOST_SPLINE.slice(0, -1))).toBeNull();
  });

  describe("the tolerance at its edge", () => {
    /** Nudge one point of a translated copy, leaving the offset it reports alone. */
    const nudged = (by: number): Segment[] => {
      const moved = translateLoop(GHOST_SPLINE, 12, 0).map((segment) => ({
        cmd: segment.cmd,
        points: [...segment.points],
      }));
      const points = moved[40]!.points;
      const last = points.length - 1;
      points[last] = { x: points[last]!.x + by, y: points[last]!.y };
      return moved;
    };

    test(`a point ${MORPH_TWIST.sameWithin} off is still the same shape`, () => {
      expect(offsetBetween(GHOST_SPLINE, nudged(MORPH_TWIST.sameWithin))).toEqual({ dx: 12, dy: 0 });
    });

    test("a point further off than that is not", () => {
      expect(offsetBetween(GHOST_SPLINE, nudged(MORPH_TWIST.sameWithin * 1.01))).toBeNull();
    });
  });
});

describe("ghostLoopsOf", () => {
  test("it recognises the ghost as drawn, and carries the twist through", () => {
    const found = ghostLoopsOf(whole(GHOST_SPLINE), [0, 10, -10]);
    expect(found).toEqual([
      { dx: 0, dy: 0, twist: 0 },
      { dx: 0, dy: 0, twist: 10 },
      { dx: 0, dy: 0, twist: -10 },
    ]);
  });

  test("it recognises the ghost wherever it sits", () => {
    const found = ghostLoopsOf([translateLoop(GHOST_SPLINE, -60, 18)], [0]);
    expect(found[0]).toEqual({ dx: -60, dy: 18, twist: 0 });
  });

  test("a loop that is not the ghost is null", () => {
    expect(ghostLoopsOf([toSpline(circleLoop(CENTRE.x, CENTRE.y, 300))], [0])).toEqual([null]);
  });

  /**
   * A mascot built straight into a state never goes through a change, so the
   * ghost bookkeeping is read off its starting shape. When that read said
   * "ghost" for a shape that is not one, the swept ghost stood in for it and
   * the mascot drew the plain ghost instead of its own silhouette. It reached
   * the user's screen.
   */
  test("only idle's silhouette is the ghost", () => {
    for (const state of STATES) {
      const { loops } = STATE[state].silhouette;
      const found = ghostLoopsOf(loops, loops.map(() => 0));
      if (state === "idle") {
        expect(found, state).toEqual(loops.map(() => ({ dx: 0, dy: 0, twist: 0 })));
      } else {
        expect(found, state).toEqual(loops.map(() => null));
      }
    }
  });
});

describe("moveLoop", () => {
  const dot = dotAt(300, 700, 84);

  test("a null motion is the loop itself", () => {
    expect(moveLoop(dot, HELD)).toBe(dot);
  });

  test("a scale is about the loop's own centre", () => {
    const centre = centreOf(dot);
    const scaled = moveLoop(dot, { shift: { x: 0, y: 0 }, scale: 0.5 });
    const after = centreOf(scaled);

    expect(after.x).toBeCloseTo(centre.x, 6);
    expect(after.y).toBeCloseTo(centre.y, 6);

    const before = boxOf(onCurve(dot));
    const now = boxOf(onCurve(scaled));
    expect(now.maxX - now.minX).toBeCloseTo((before.maxX - before.minX) * 0.5, 6);
    expect(now.maxY - now.minY).toBeCloseTo((before.maxY - before.minY) * 0.5, 6);
  });

  test("a shift moves the loop and leaves its size alone", () => {
    const moved = moveLoop(dot, { shift: { x: 30, y: -12 }, scale: 1 });
    const centre = centreOf(dot);
    const after = centreOf(moved);

    expect(after.x).toBeCloseTo(centre.x + 30, 6);
    expect(after.y).toBeCloseTo(centre.y - 12, 6);
    expect(sameLoop(dot, moved)).toBe(true);
  });
});

describe("blendFace and rideFace", () => {
  const a = STATE.idle.silhouette.face;
  const b = STATE.success.silhouette.face;

  test("the blend is exact at both ends", () => {
    expect(blendFace(a, b, 0)).toEqual({ ...a, rides: b.rides });
    expect(blendFace(a, b, 1)).toEqual({ ...b });
  });

  test("the blend is monotonic between them", () => {
    // Every number of the layout, because the assembly has to arrive whole:
    // an eye that overshoots and comes back is a head that wobbles.
    const fields: (readonly [string, (face: FaceLayout) => number])[] = [
      ["x", (face) => face.x],
      ["y", (face) => face.y],
      ["spread", (face) => face.spread],
      ["scale", (face) => face.scale],
      ["knot.x", (face) => face.knot.x],
      ["knot.y", (face) => face.knot.y],
      ["tailScale", (face) => face.tailScale],
    ];

    for (const [name, read] of fields) {
      const from = read(a);
      const to = read(b);
      let last = from;
      for (let step = 1; step <= 10; step++) {
        const t = step / 10;
        const now = read(blendFace(a, b, t));
        // Toward the target, never past it, and never back the way it came.
        expect(Math.abs(now - to), name).toBeLessThanOrEqual(Math.abs(last - to) + 1e-9);
        expect((now - last) * (to - from), name).toBeGreaterThanOrEqual(-1e-9);
        expect(now, name).toBeCloseTo(from + (to - from) * t, 9);
        last = now;
      }
      expect(last, name).toBeCloseTo(to, 9);
    }
  });

  /**
   * `rides` names a loop of the target, so it cannot be interpolated. Blending
   * it would name loop 0.5 halfway through a change and the head would ride
   * whichever loop the rounding fell on.
   */
  test("rides comes from the target, not from the blend", () => {
    const dots = STATE.loading.silhouette.face;
    expect(dots.rides).not.toBe(a.rides);
    for (const t of [0, 0.001, 0.5, 1]) {
      expect(blendFace(a, dots, t).rides).toBe(dots.rides);
    }
  });

  test("riding by a null shift is the same layout", () => {
    expect(rideFace(a, { x: 0, y: 0 })).toBe(a);
  });

  test("riding carries the eyes and the knot together", () => {
    const moved = rideFace(a, { x: 15, y: -7 });
    expect(moved.x).toBeCloseTo(a.x + 15, 9);
    expect(moved.y).toBeCloseTo(a.y - 7, 9);
    expect(moved.knot.x).toBeCloseTo(a.knot.x + 15, 9);
    expect(moved.knot.y).toBeCloseTo(a.knot.y - 7, 9);
    // Nothing else moves: the head travels, it does not resize.
    expect(moved.spread).toBe(a.spread);
    expect(moved.scale).toBe(a.scale);
    expect(moved.tailScale).toBe(a.tailScale);
  });
});

describe("perLoop and twins", () => {
  // The saving is a performance guarantee, not an optimisation that happens to
  // hold: the distinct loops are worked out three times a frame — the body
  // path, the head mask, and the shape clip.
  const ghost = STATE.idle.silhouette.loops;
  const bang = STATE.error.silhouette.loops;
  const dots = STATE.loading.silhouette.loops;

  const distinct = (twins: readonly number[]) => twins.filter((twin, i) => twin === i).length;

  test("a whole shape costs one loop, not PARTS", () => {
    const twins = twinsOf(ghost, ghost, NO_GESTURE.loops);
    expect(twins).toEqual([0, 0, 0]);
    expect(distinct(twins)).toBe(1);
  });

  test("the exclamation mark costs two", () => {
    const twins = twinsOf(bang, bang, NO_GESTURE.loops);
    expect(twins).toEqual([0, 1, 1]);
    expect(distinct(twins)).toBe(2);
  });

  test("three separate pieces cost three", () => {
    expect(distinct(twinsOf(dots, dots, NO_GESTURE.loops))).toBe(PARTS);
  });

  test("a change is a copy only when both ends and the gesture agree", () => {
    // The same target from three different sources is three loops.
    expect(distinct(twinsOf(dots, ghost, NO_GESTURE.loops))).toBe(PARTS);
    // And a gesture that moves one loop of a whole shape splits it off.
    const pulled: LoopMove[] = [HELD, HELD, { shift: { x: 4, y: 0 }, scale: 1 }];
    expect(twinsOf(ghost, ghost, pulled)).toEqual([0, 0, 2]);
  });

  test("perLoop works a copy out once and hands on the result", () => {
    const twins = twinsOf(ghost, ghost, NO_GESTURE.loops);
    const asked: number[] = [];
    const made = perLoop(twins, (i) => {
      asked.push(i);
      return { i };
    });

    expect(asked).toEqual([0]);
    expect(made.length).toBe(PARTS);
    for (const value of made) expect(value).toBe(made[0]!);
  });

  test("perLoop keeps the order of the loops", () => {
    const twins = twinsOf(bang, bang, NO_GESTURE.loops);
    const made = perLoop(twins, (i) => i * 10);

    expect(made).toEqual([0, 10, 10]);
    expect(made.length).toBe(PARTS);
    // Every copy holds exactly what its twin holds.
    made.forEach((value, i) => expect(value).toBe(made[twins[i]!]!));
  });
});

describe("faceMap and knotMap", () => {
  test("the ghost's own layout is the identity, so the artwork is reproduced", () => {
    const place = faceMap(GHOST_FACE);
    for (const point of [ANCHOR.eyeLeft, ANCHOR.eyeRight, ANCHOR.browLeft.outer, { x: 0, y: 0 }]) {
      const moved = place(point);
      expect(moved.x).toBeCloseTo(point.x, 9);
      expect(moved.y).toBeCloseTo(point.y, 9);
    }
  });

  test("the knot's own layout is the identity too", () => {
    const place = knotMap(GHOST_FACE);
    const moved = place(ANCHOR.knot);
    expect(moved.x).toBeCloseTo(ANCHOR.knot.x, 9);
    expect(moved.y).toBeCloseTo(ANCHOR.knot.y, 9);
  });

  test("another layout scales the head assembly about the layout's own origin", () => {
    const face = STATE.success.silhouette.face;
    const place = faceMap(face);
    const origin = place({ x: GHOST_FACE.x, y: GHOST_FACE.y });

    expect(origin.x).toBeCloseTo(face.x, 9);
    expect(origin.y).toBeCloseTo(face.y, 9);

    // The eyes keep their proportions: the spread carries x, the scale y.
    const spread = face.spread / GHOST_FACE.spread;
    const moved = place(ANCHOR.eyeRight);
    expect(moved.x).toBeCloseTo(face.x + (ANCHOR.eyeRight.x - GHOST_FACE.x) * spread, 9);
    expect(moved.y).toBeCloseTo(face.y + (ANCHOR.eyeRight.y - GHOST_FACE.y) * face.scale, 9);
  });

  test("the knot scales about the layout's knot, by the tail scale", () => {
    const face = STATE.thinking.silhouette.face;
    const place = knotMap(face);
    const origin = place(GHOST_FACE.knot);

    expect(origin.x).toBeCloseTo(face.knot.x, 9);
    expect(origin.y).toBeCloseTo(face.knot.y, 9);

    const away = place({ x: GHOST_FACE.knot.x + 100, y: GHOST_FACE.knot.y - 40 });
    expect(away.x).toBeCloseTo(face.knot.x + 100 * face.tailScale, 9);
    expect(away.y).toBeCloseTo(face.knot.y - 40 * face.tailScale, 9);
  });
});

describe("the ghost's hem is the one place the mask leaves the body", () => {
  /**
   * The head anchor makes a shape nest *locally* about the head, not
   * everywhere. The ghost is the only concave silhouette, and at a full turn
   * its swept scallops reach far enough from the head that a few mask points
   * fall outside the hem.
   *
   * That is harmless, and this is the measurement that says so: everything
   * that escapes is at the bottom of the skirt, and the band cannot paint
   * within a hundred units of it. The test exists so that a change which
   * brings the two together fails here instead of on screen.
   */
  const sweepsOfTheGhost = (): number[] => {
    const out: number[] = [];
    for (let d = -TURN.degrees; d <= TURN.degrees; d += 3) {
      out.push(((d * Math.PI) / 180) * TURN.hemShare);
    }
    return out;
  };

  test("what escapes is the hem, and only at a turn", () => {
    const head = { x: GHOST_FACE.x, y: GHOST_FACE.y };
    let highest = Infinity;
    let worst = 0;

    for (const sweep of sweepsOfTheGhost()) {
      const loop = ghostSpline(sweep);
      const mask = bandMaskLoop(loop, 0, whole(loop), 0, head);
      const away = onCurve(mask).filter((point) => !inside(point, flatten(loop, 6)));
      worst = Math.max(worst, away.length);
      for (const point of away) highest = Math.min(highest, point.y);
    }

    // Facing forward the ghost's mask nests completely.
    expect(pointsOutside(bandMaskLoop(GHOST_SPLINE, 0, whole(GHOST_SPLINE), 0, head), GHOST_SPLINE)).toBe(0);
    // Turned, a handful of points leave, and every one is down at the hem.
    expect(worst).toBeLessThanOrEqual(8);
    expect(highest).toBeGreaterThan(800);
  });

  test("the band cannot reach the hem", () => {
    // The band at its lowest, carried onto the ghost the way the rig carries
    // it. The hem escapes start below y 800, so this is the clearance that
    // keeps them off the screen.
    const band = boxOf(flatten(bandRing(0), 4).map(faceMap(GHOST_FACE)));
    expect(band.maxY).toBeLessThan(700);
  });
});
