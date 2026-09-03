/**
 * The shapes a silhouette can be made of, and how the character sits on one.
 *
 * A morph between two paths only works when both carry the same command list,
 * so every shape — the ghost included — is resampled to the same number of
 * evenly spaced points and rebuilt as a closed spline. After that, blending is
 * one lerp per point and there is nothing to reconcile at run time.
 *
 * Which shape each state uses, and why, lives with the state in `states/`.
 * This module only knows how to build them.
 */

import { ANCHOR, BODY_REST, FRAME } from "./art.ts";
import {
  alignLoop,
  closedSpline,
  flatten,
  orientClockwise,
  parsePath,
  resampleClosed,
  type Point,
  type Segment,
} from "./geometry.ts";

/**
 * How many loops the silhouette is drawn as.
 *
 * A single shape is drawn as this many identical copies, which the fill rule
 * renders once. A shape that splits — the exclamation mark — pulls the copies
 * apart. So every silhouette shares one topology, single or split, and
 * blending between them needs nothing special: each copy just travels.
 */
export const PARTS = 3;

/**
 * How many points every shape is resampled to.
 *
 * High enough that the resampled ghost holds the exact artwork, so entering a
 * morph shows no step. Measured: 0.15 units at the 128 shared points, and 0.53
 * at the worst place on the curve between them, which is about a sixth of a
 * pixel at a 300 px render.
 */
export const POINTS = 128;

/**
 * Where the shapes sit, and which way point zero faces.
 *
 * Sizes are held back from the tile edge: the shape plus its entry beat plus
 * the ambient breath all stack, and the tile clips.
 */
export const CENTRE: Point = { x: 490, y: 513 };
const START: Point = { x: -1, y: 0 };

/**
 * How a shape wears the character.
 *
 * Nothing is ever dropped. The silhouette changes; the visor, the eyes, the
 * brows, the acid band, the knot, and the tails all travel with it, placed and
 * scaled to suit the new outline. This layout is what tells them where to go.
 */
export interface FaceLayout {
  /** Horizontal centre of the eye pair. */
  readonly x: number;
  /** Vertical centre of the eyes. */
  readonly y: number;
  /** Half the distance between the eyes. */
  readonly spread: number;
  /** Size of the whole head assembly — visor, band, eyes, brows. */
  readonly scale: number;
  /** Where the headband knot sits, and therefore where the tails hang from. */
  readonly knot: { readonly x: number; readonly y: number };
  /** Tail size, relative to the ghost. */
  readonly tailScale: number;
  /** Which loop the head rides. When that loop moves, the head moves with it. */
  readonly rides: number;
}

export interface Silhouette {
  readonly loops: readonly (readonly Segment[])[];
  readonly face: FaceLayout;
}

/** The face as drawn. Note that it sits a little left of the body centre. */
export const GHOST_FACE: FaceLayout = {
  x: 469.54,
  y: 566,
  spread: 106.54,
  scale: 1,
  knot: ANCHOR.knot,
  tailScale: 1,
  rides: 0,
};

// ------------------------------------------------------------- loop builders

export function circleLoop(cx: number, cy: number, r: number, dense = 512): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < dense; i++) {
    const a = (i / dense) * Math.PI * 2;
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

/**
 * A polygon with rounded corners, as a dense loop.
 *
 * Corners must be given clockwise in screen coordinates, so the loop winds the
 * same way the ghost does and the morph does not turn itself inside out.
 */
export function roundedPolygonLoop(corners: readonly Point[], radius: number, perCorner = 40): Point[] {
  const n = corners.length;
  const out: Point[] = [];

  for (let i = 0; i < n; i++) {
    const previous = corners[(i - 1 + n) % n]!;
    const corner = corners[i]!;
    const next = corners[(i + 1) % n]!;

    const toPrevious = normalise({ x: previous.x - corner.x, y: previous.y - corner.y });
    const toNext = normalise({ x: next.x - corner.x, y: next.y - corner.y });
    const reach = Math.min(
      radius,
      Math.hypot(previous.x - corner.x, previous.y - corner.y) / 2,
      Math.hypot(next.x - corner.x, next.y - corner.y) / 2,
    );

    const start = { x: corner.x + toPrevious.x * reach, y: corner.y + toPrevious.y * reach };
    const end = { x: corner.x + toNext.x * reach, y: corner.y + toNext.y * reach };

    // The straight run into the corner, then a quadratic sweep around it.
    out.push(start);
    for (let s = 1; s <= perCorner; s++) {
      const t = s / perCorner;
      const u = 1 - t;
      out.push({
        x: u * u * start.x + 2 * u * t * corner.x + t * t * end.x,
        y: u * u * start.y + 2 * u * t * corner.y + t * t * end.y,
      });
    }
  }
  return out;
}

function normalise(v: Point): Point {
  const length = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / length, y: v.y / length };
}

/**
 * Bring any closed loop to the shared form: clockwise, POINTS points, starting
 * at the same place. Only shapes in that form can be blended into each other.
 *
 * A loop that is not centred on the canvas is aligned about its own centre, or
 * its start point lands wherever happens to face left of the canvas centre and
 * that copy picks up a twist of its own.
 */
export function toSpline(loop: readonly Point[], centre: Point = CENTRE): Segment[] {
  return closedSpline(alignLoop(orientClockwise(resampleClosed(loop, POINTS)), centre, START));
}

/** One shape as PARTS identical loops. */
export function whole(spline: readonly Segment[]): readonly (readonly Segment[])[] {
  return Array.from({ length: PARTS }, () => spline);
}

/** The split shapes, one loop per piece, padded to PARTS by repeating the last. */
export function split(pieces: readonly (readonly Segment[])[]): readonly (readonly Segment[])[] {
  const out = [...pieces];
  while (out.length < PARTS) out.push(pieces[pieces.length - 1]!);
  return out;
}

export function dotAt(x: number, y: number, r: number): Segment[] {
  return toSpline(circleLoop(x, y, r), { x, y });
}

// ------------------------------------------------------------------ shapes

/**
 * The ghost, built from its measurements.
 *
 * The artwork is a semicircular dome on straight sides with a scalloped hem,
 * to within a fifth of a unit. Building it from those parts rather than
 * resampling the path is what lets the hem turn: the scallops are read off the
 * artwork once as a pattern round the rim of the skirt, the pattern is
 * repeated round the back, and a yaw simply reads it from a different angle.
 * New scallops come into view on one side as others go round the other, the
 * way a real turned skirt behaves — instead of the three on the front
 * stretching and bunching.
 *
 * At a yaw of zero this is the artwork: measured max deviation 0.15 units
 * across the 128 shared points. `shapes.test.ts` holds that claim.
 */

/** How many samples the hem pattern is read at, round the front of the skirt. */
const HEM_SAMPLES = 180;

/** The hem's height at each angle round the front of the skirt, read off the artwork. */
const HEM_PATTERN: readonly number[] = (() => {
  const outline = flatten(parsePath(BODY_REST), 48);
  const bottomAt = (x: number): number => {
    let lowest = -Infinity;
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      if (a.x <= x !== b.x <= x) {
        const y = a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
        if (y > lowest) lowest = y;
      }
    }
    return lowest;
  };
  const out: number[] = [];
  for (let i = 0; i <= HEM_SAMPLES; i++) {
    const angle = -Math.PI / 2 + (Math.PI * i) / HEM_SAMPLES;
    // Fractionally inside the rim, so the sample lands on the artwork.
    out.push(bottomAt(FRAME.cx + FRAME.halfWidth * Math.sin(angle) * 0.9995));
  }
  return out;
})();

/**
 * The hem height at any angle round the skirt. The front half is the artwork;
 * the back half repeats it, and the two meet at the corners, which sit at the
 * same height on both sides.
 */
function hemAt(angle: number): number {
  const a = ((((angle + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI);
  const f = (a / Math.PI) * HEM_SAMPLES;
  const i = Math.min(HEM_SAMPLES - 1, Math.floor(f));
  const t = f - i;
  return HEM_PATTERN[i]! + (HEM_PATTERN[i + 1]! - HEM_PATTERN[i]!) * t;
}

/**
 * The ghost's outline with its hem turned by `sweep` radians, built from the
 * measurements. Starts at the left shoulder and runs clockwise, like the
 * artwork.
 *
 * This is the heaviest pure function in the rig: about 330 dense points, a
 * resample to POINTS by arc length, and a closed spline over the result. Go
 * through `ghostSpline`, which memoises it.
 */
function buildGhostSpline(sweep: number): Segment[] {
  const { cx, halfWidth: r, shoulder } = FRAME;
  const dense: Point[] = [];
  // The dome, left shoulder over the top to the right shoulder.
  for (let i = 0; i <= 120; i++) {
    const a = Math.PI + (Math.PI * i) / 120;
    dense.push({ x: cx + r * Math.cos(a), y: shoulder + r * Math.sin(a) });
  }
  const rightCorner = hemAt(Math.PI / 2 - sweep);
  const leftCorner = hemAt(-Math.PI / 2 - sweep);
  for (let i = 1; i <= 30; i++) dense.push({ x: cx + r, y: shoulder + ((rightCorner - shoulder) * i) / 30 });
  // The hem, right corner to left, read off the pattern at the turned angle.
  for (let i = 1; i <= HEM_SAMPLES; i++) {
    const angle = Math.PI / 2 - (Math.PI * i) / HEM_SAMPLES;
    dense.push({ x: cx + r * Math.sin(angle), y: hemAt(angle - sweep) });
  }
  for (let i = 1; i < 30; i++) dense.push({ x: cx - r, y: leftCorner + ((shoulder - leftCorner) * i) / 30 });
  return closedSpline(orientClockwise(resampleClosed(dense, POINTS)));
}

/**
 * How finely the sweep is rounded before the memo looks it up, in radians.
 *
 * The whole live range is one turn of the hem — at most 45 degrees times
 * `TURN.hemShare`, so about -0.55 to 0.55 radians — and the yaw crosses it
 * slowly: idle's look-around moves the sweep at most 0.0005 radians a frame.
 * So a step of this size is what makes consecutive frames ask for the same
 * hem instead of two hems a hair apart.
 *
 * What the rounding costs. A scallop keeps its own angle round the rim of the
 * skirt, so a sweep of `d` radians carries it sideways by at most the rim
 * radius times `d` — about 310 units a radian here. The error is half a step
 * of that at worst, and it only reaches the whole of it where the outline is
 * steep enough to take the shift across the curve. Measured against the
 * unrounded shape over the live range: 0.047 units at worst and 0.018
 * typical, against a body about 620 units wide, a resample to POINTS points,
 * and an emitted path that rounds to 0.01 units anyway. At a 300 px render
 * 0.047 units is a seventieth of a pixel, so no step can be seen.
 */
const SWEEP_QUANTUM = 0.0004;

/**
 * The last hem built, and the rounded sweep it was built for.
 *
 * One entry, which is both the bound and the fastest thing measured. A spline
 * of POINTS points is about 40 kB of small objects, and keeping more than the
 * current one alive costs more in collection than the builds it saves: with
 * two entries held, 20 000 calls of idle drift ran 11.1 us each against 8.0
 * us with one, and a yaw dragged across the whole range — every call a miss —
 * went from level with the old code to half again as slow. One entry is also
 * all the shape of the demand needs: a yaw the application holds asks for the
 * same hem every frame, and a drifting yaw asks for the one it asked for last.
 */
let memoKey = NaN;
let memoHem: readonly Segment[] = [];

/**
 * The ghost's outline with its hem turned by `sweep` radians, as the shared
 * spline. Starts at the left shoulder and runs clockwise, like the artwork.
 *
 * The renderer calls this on every frame the head is not straight on, and
 * idle is almost never straight on, so the build is memoised on the rounded
 * sweep. A sweep of zero rounds to zero and is built from zero, so
 * `GHOST_SPLINE` and the resting fast path still get the artwork's own
 * geometry, byte for byte.
 *
 * The array handed back is a fresh one, as it always was, over the held
 * segments. A segment and its points are read-only, so sharing them is safe,
 * and no caller can write through to the memo.
 */
export function ghostSpline(sweep: number): Segment[] {
  const key = Math.round(sweep / SWEEP_QUANTUM);
  if (key !== memoKey) {
    memoKey = key;
    memoHem = buildGhostSpline(key * SWEEP_QUANTUM);
  }
  return [...memoHem];
}

/** The ghost as drawn, with its hem facing forward. */
export const GHOST_SPLINE: readonly Segment[] = ghostSpline(0);

/** An axis-aligned box about the centre, clockwise. */
export function box(halfWidth: number, halfHeight: number): Point[] {
  const { x, y } = CENTRE;
  return [
    { x: x - halfWidth, y: y - halfHeight },
    { x: x + halfWidth, y: y - halfHeight },
    { x: x + halfWidth, y: y + halfHeight },
    { x: x - halfWidth, y: y + halfHeight },
  ];
}

/** A regular polygon, clockwise, with `turn` degrees of rotation. */
export function regular(sides: number, radius: number, turn: number): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < sides; i++) {
    const a = ((turn - 90) * Math.PI) / 180 + (i / sides) * Math.PI * 2;
    out.push({ x: CENTRE.x + Math.cos(a) * radius, y: CENTRE.y + Math.sin(a) * radius });
  }
  return out;
}
