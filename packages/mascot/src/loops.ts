/**
 * The algebra of the three-loop silhouette, and of placing the head on it.
 *
 * The silhouette is always `PARTS` loops, whatever shape it is. Everything
 * here is about those loops and nothing else: whether two of them are the same
 * shape, which of them are the ghost and where, which of them are copies that
 * need working out only once, how one moves under a gesture, and how the head
 * assembly is carried from the ghost's layout onto whatever the outline has
 * become — including the inset outline the band is trimmed against.
 *
 * None of it touches the DOM, and none of it holds any state. The runtime in
 * `mascot.ts` calls into this layer every frame; this layer never calls back.
 */

import { BAND_INSET } from "./art.ts";
import { mapPath, type Point, type Segment } from "./geometry.ts";
import { MORPH_TWIST } from "./motion.ts";
import { GHOST_FACE, GHOST_SPLINE, type FaceLayout } from "./shapes.ts";

/**
 * How one loop of the silhouette moves within a gesture.
 *
 * This is `LoopMotion` from `states/definition.ts`, restated by its shape so
 * this layer stays clear of the state contract. A `LoopMotion` satisfies it.
 */
export interface LoopMove {
  readonly shift: Point;
  /** Scale about the loop's own centre. */
  readonly scale: number;
}

/** The centre of a loop's bounding box. */
export function centreOf(segments: readonly Segment[]): Point {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const segment of segments) {
    for (const p of segment.points) {
      if (p.x < l) l = p.x;
      if (p.x > r) r = p.x;
      if (p.y < t) t = p.y;
      if (p.y > b) b = p.y;
    }
  }
  return { x: (l + r) / 2, y: (t + b) / 2 };
}

/** Where a ghost loop sits relative to the ghost as drawn, and how it is twisted. */
export interface GhostLoop {
  readonly dx: number;
  readonly dy: number;
  readonly twist: number;
}

/**
 * The translation that carries loop `a` onto loop `b`, or null when they are
 * not the same shape. Shapes of the shared topology are compared point by
 * point; a shape that only moves counts as the same shape.
 */
export function offsetBetween(
  a: readonly Segment[],
  b: readonly Segment[],
): { dx: number; dy: number } | null {
  if (a.length !== b.length) return null;
  const within = MORPH_TWIST.sameWithin;
  const first = (loop: readonly Segment[]) => loop[0]!.points[loop[0]!.points.length - 1]!;
  const dx = first(b).x - first(a).x;
  const dy = first(b).y - first(a).y;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!.points[a[i]!.points.length - 1]!;
    const q = b[i]!.points[b[i]!.points.length - 1]!;
    if (Math.abs(p.x + dx - q.x) > within || Math.abs(p.y + dy - q.y) > within) return null;
  }
  return { dx, dy };
}

/** True when two loops of the shared topology are the same shape, wherever each sits. */
export function sameLoop(a: readonly Segment[], b: readonly Segment[]): boolean {
  return offsetBetween(a, b) !== null;
}

/** Which of a silhouette's loops are the ghost, where each sits, and how each is twisted. */
export function ghostLoopsOf(
  loops: readonly (readonly Segment[])[],
  twists: readonly number[],
): (GhostLoop | null)[] {
  return loops.map((loop, i) => {
    const offset = offsetBetween(GHOST_SPLINE, loop);
    return offset === null ? null : { ...offset, twist: twists[i]! };
  });
}

export function translateLoop(loop: readonly Segment[], dx: number, dy: number): readonly Segment[] {
  if (dx === 0 && dy === 0) return loop;
  return mapPath(loop, (p) => ({ x: p.x + dx, y: p.y + dy }));
}

/**
 * Which earlier loop each loop is a copy of, by index. `twin[i] === i` marks a
 * loop that has to be worked out for itself.
 *
 * The silhouette is always PARTS loops, and most shapes are one loop repeated:
 * a whole shape is PARTS identical copies, which the nonzero fill rule renders
 * exactly once. Working all three out separately is the largest per-frame cost
 * in the rig, and it is spent three times over — the body path, the head mask,
 * and the shape clip.
 *
 * A copy is recognised by reference, which costs nothing: `whole()` hands the
 * same array to every part, a padded split shape repeats the reference of its
 * last piece, and a held gesture shares one `LoopMotion` between the parts. Two
 * loops off the same source geometry, carrying the same gesture, must come out
 * the same. Where the references differ the work is simply done.
 */
export function twinsOf(
  from: readonly (readonly Segment[])[],
  to: readonly (readonly Segment[])[],
  motion: readonly LoopMove[],
): number[] {
  return to.map((_, i) => {
    for (let j = 0; j < i; j++) {
      if (from[i] === from[j] && to[i] === to[j] && motion[i] === motion[j]) return j;
    }
    return i;
  });
}

/** Work a value out once per distinct loop, and hand the copies the same result. */
export function perLoop<T>(twins: readonly number[], make: (index: number) => T): T[] {
  const out: T[] = [];
  for (let i = 0; i < twins.length; i++) out.push(twins[i] === i ? make(i) : out[twins[i]!]!);
  return out;
}

/** Move a loop by its gesture: shifted, and scaled about its own centre. */
export function moveLoop(loop: readonly Segment[], motion: LoopMove): readonly Segment[] {
  if (motion.scale === 1 && motion.shift.x === 0 && motion.shift.y === 0) return loop;
  const c = centreOf(loop);
  return mapPath(loop, (p) => ({
    x: c.x + (p.x - c.x) * motion.scale + motion.shift.x,
    y: c.y + (p.y - c.y) * motion.scale + motion.shift.y,
  }));
}

/**
 * Move a point from the ghost's head space into the head of another shape.
 *
 * The whole assembly travels through this: visor, band, eyes, brows. They keep
 * their relationship to each other, so an exclamation mark wears the same face the
 * ghost does, only smaller and elsewhere.
 */
export function faceMap(face: FaceLayout): (point: Point) => Point {
  const spread = face.spread / GHOST_FACE.spread;
  return (point: Point): Point => ({
    x: face.x + (point.x - GHOST_FACE.x) * spread,
    y: face.y + (point.y - GHOST_FACE.y) * face.scale,
  });
}

/** The same idea for the knot, which the tails hang from. */
export function knotMap(face: FaceLayout): (point: Point) => Point {
  return (point: Point): Point => ({
    x: face.knot.x + (point.x - GHOST_FACE.knot.x) * face.tailScale,
    y: face.knot.y + (point.y - GHOST_FACE.knot.y) * face.tailScale,
  });
}

export function compose(
  outer: (point: Point) => Point,
  inner: (point: Point) => Point,
): (point: Point) => Point {
  return (point: Point): Point => outer(inner(point));
}

/** Carry the head along with the loop it rides. */
export function rideFace(face: FaceLayout, shift: Point): FaceLayout {
  if (shift.x === 0 && shift.y === 0) return face;
  return {
    ...face,
    x: face.x + shift.x,
    y: face.y + shift.y,
    knot: { x: face.knot.x + shift.x, y: face.knot.y + shift.y },
  };
}

export function blendFace(a: FaceLayout, b: FaceLayout, t: number): FaceLayout {
  const mix = (from: number, to: number) => from + (to - from) * t;
  return {
    x: mix(a.x, b.x),
    y: mix(a.y, b.y),
    spread: mix(a.spread, b.spread),
    scale: mix(a.scale, b.scale),
    knot: { x: mix(a.knot.x, b.knot.x), y: mix(a.knot.y, b.knot.y) },
    tailScale: mix(a.tailScale, b.tailScale),
    rides: b.rides,
  };
}

/** A loop pulled in toward `about` by `BAND_INSET`. */
export function insetLoop(shape: readonly Segment[], about: Point): Segment[] {
  return mapPath(shape, (point) => ({
    x: about.x + (point.x - about.x) * BAND_INSET,
    y: about.y + (point.y - about.y) * BAND_INSET,
  }));
}

/**
 * One loop of the silhouette pulled in from the outline: the band's mask, and
 * the clip every part worn on the head is inside.
 *
 * The loop the head rides — and any copy of it stacked on top of it — is
 * pulled in toward the head itself; every other loop toward its own centre. A
 * concave shape does not nest inside itself when scaled about its bounding
 * box, but it does nest locally about any point in the thick of its own ink,
 * and the head is the only place the band is.
 *
 * The head anchor is only taken when the loop really holds it. Trusting the
 * layout alone put the anchor outside the loop it was insetting in two ways,
 * and a shape scaled about a point outside itself does not nest at all:
 *
 * - A copy that is the same shape *moved* is a separate piece, not a copy.
 *   The ellipsis's outer dots are the middle dot, 262 units to each side, and
 *   the head sits on the middle one. Measured: 55 of 128 mask points outside
 *   each outer dot.
 * - `rides` comes from the target of a change as soon as the change starts, so
 *   part-way through the morph that leaves the ellipsis the head was said to
 *   ride a loop it had not reached yet. Measured a twentieth of the way in:
 *   108 of 128 points outside, and by then the band is wide enough to paint
 *   the ground they escape over.
 *
 * `shape` is the loop as drawn, after the field. `parts` are the same loops
 * before it, which is where a stacked copy can still be recognised, and `head`
 * is the head anchor carried through the field.
 */
export function bandMaskLoop(
  shape: readonly Segment[],
  index: number,
  parts: readonly (readonly Segment[])[],
  rides: number,
  head: Point,
): Segment[] {
  const offset = index === rides ? { dx: 0, dy: 0 } : offsetBetween(parts[index]!, parts[rides]!);
  const stacked = offset !== null && offset.dx === 0 && offset.dy === 0;
  return insetLoop(shape, stacked && holds(shape, head) ? head : centreOf(shape));
}

/**
 * Whether a point is inside a closed loop, by ray casting along the loop's own
 * points. Every loop the rig masks is the shared spline, so its points are a
 * fine enough outline to decide this, and there is no need to flatten first.
 */
function holds(loop: readonly Segment[], point: Point): boolean {
  const outline = onCurveOf(loop);
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i]!;
    const b = outline[j]!;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** The points a spline passes through: the end point of every segment. */
function onCurveOf(loop: readonly Segment[]): Point[] {
  return loop.map((segment) => segment.points[segment.points.length - 1]!);
}
