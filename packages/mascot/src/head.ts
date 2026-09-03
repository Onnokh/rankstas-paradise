/**
 * The head as a sphere, and the yaw that turns it.
 *
 * The head is treated as a sphere of the dome's radius about the body's axis.
 * Every head point — visor, eyes, brows, band, knot — has an angle on that
 * sphere. A point at rest is the front view, so its angle is the arcsine of its
 * offset from the axis, and a yaw re-projects it: x = axis + radius · sin(angle
 * + yaw). Heights do not change. Nothing slides; everything rotates.
 *
 * Everything the turn does follows from that one rule. The far side compresses
 * and the near side opens up, because the local scale of the projection is the
 * foreshortening. The band is a ring, sampled off the artwork once round the
 * front and mirrored round the back, so its crest swings across the outline
 * instead of the strip shifting sideways. The knot is a point on the rim, and
 * goes round the back where the body hides it.
 *
 * The silhouette itself does not change: a round head has the same outline from
 * every angle. The mascot never rotates in the plane.
 *
 * This module holds the model alone. It touches no DOM and knows nothing of the
 * rig, so it can be measured on its own. The runtime maps its output through
 * the face layout of whatever the silhouette has become, and then through the
 * deformation field.
 */

import { ANCHOR, BAND_REST, FRAME } from "./art.ts";
import { flatten, parsePath, type Point, type Segment } from "./geometry.ts";
import { clamp } from "./motion.ts";

const IDENTITY = (point: Point): Point => point;

/**
 * The yaw model. The head is a sphere of the dome's radius about the body's
 * axis, in the ghost's head space; the face layout scales it onto whatever the
 * silhouette has become.
 */
export const HEAD = { axis: FRAME.cx, radius: FRAME.halfWidth } as const;

/** The angle of a head point on the sphere, from straight ahead. */
export function angleOf(x: number): number {
  return Math.asin(clamp((x - HEAD.axis) / HEAD.radius, -1, 1));
}

/** Where a point at that angle lands after a yaw. */
export function project(angle: number, yaw: number): number {
  return HEAD.axis + HEAD.radius * Math.sin(angle + yaw);
}

/** How far toward the viewer a point at that angle sits after a yaw: 1 in front, 0 at the rim, below 0 behind. */
export function depthOf(angle: number, yaw: number): number {
  return Math.cos(angle + yaw);
}

/** Re-project every head point through the yaw. Heights do not change. */
export function yawWarp(yaw: number): (point: Point) => Point {
  if (yaw === 0) return IDENTITY;
  return (point: Point): Point => ({ x: project(angleOf(point.x), yaw), y: point.y });
}

/**
 * The band as a ring around the head, sampled once from the artwork.
 *
 * For each angle round the front of the head this holds the band's top and
 * bottom edge. Round the back the ring is assumed to mirror the front — a
 * tilted ring is symmetric about the angle where it peaks — so the visible
 * half can be drawn from any yaw.
 */
export const RING_SAMPLES = 48;
export const RING = (() => {
  const outline = flatten(parsePath(BAND_REST));
  const heights = (x: number): { top: number; bottom: number } | null => {
    const hits: number[] = [];
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i]!;
      const b = outline[(i + 1) % outline.length]!;
      if (a.x <= x !== b.x <= x) hits.push(a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
    }
    if (hits.length < 2) return null;
    return { top: Math.min(...hits), bottom: Math.max(...hits) };
  };
  const top: number[] = [];
  const bottom: number[] = [];
  let last: { top: number; bottom: number } | null = null;
  for (let i = 0; i <= RING_SAMPLES; i++) {
    const angle = -Math.PI / 2 + (Math.PI * i) / RING_SAMPLES;
    // Just inside the rim, so the sample lands on the artwork.
    const x = HEAD.axis + HEAD.radius * Math.sin(angle) * 0.999;
    last = heights(x) ?? last;
    top.push(last?.top ?? 0);
    bottom.push(last?.bottom ?? 0);
  }
  // Where the artwork runs out short of the rim, the last value is held.
  return { top, bottom };
})();

/** The ring's edge heights at any angle, front or back. */
export function ringAt(angle: number): { top: number; bottom: number } {
  // Fold the back onto the front: the ring peaks at the rim and comes back down.
  let a = ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  if (a > Math.PI / 2) a = Math.PI - a;
  if (a < -Math.PI / 2) a = -Math.PI - a;
  const f = ((a + Math.PI / 2) / Math.PI) * RING_SAMPLES;
  const i = clamp(Math.floor(f), 0, RING_SAMPLES - 1);
  const t = f - i;
  return {
    top: RING.top[i]! + (RING.top[i + 1]! - RING.top[i]!) * t,
    bottom: RING.bottom[i]! + (RING.bottom[i + 1]! - RING.bottom[i]!) * t,
  };
}

/** How far below the strip's centre line the knot sits, read off the artwork. */
export const KNOT_ON_STRIP = (() => {
  const strip = ringAt(angleOf(ANCHOR.knot.x));
  return ANCHOR.knot.y - (strip.top + strip.bottom) / 2;
})();

/** An angle folded into -π..π. */
export function wrapAngle(angle: number): number {
  return ((((angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

/** The visible half of the band ring after a yaw, as a closed outline in head space. */
export function bandRing(yaw: number): Segment[] {
  const from = -Math.PI / 2 - yaw;
  const to = Math.PI / 2 - yaw;
  const topEdge: Point[] = [];
  const bottomEdge: Point[] = [];
  for (let i = 0; i <= RING_SAMPLES; i++) {
    const angle = from + ((to - from) * i) / RING_SAMPLES;
    // Fractionally past the rim on both ends, so the mask always has band to trim.
    const x = project(angle, yaw) + (i === 0 ? -4 : i === RING_SAMPLES ? 4 : 0);
    const { top, bottom } = ringAt(angle);
    topEdge.push({ x, y: top });
    bottomEdge.push({ x, y: bottom });
  }
  // Past the rim of the head sphere the strip carries straight on, along the
  // slope it arrived with, far enough to cross any body the silhouette may
  // have become. The head sphere is the body's rim only for the ghost and the
  // circle; a diamond or a square is wider at band height, and a band that
  // stopped at the sphere left a wedge of ink between its end and the edge.
  // The inset mask trims the extension to the body, exactly as it trims the
  // artwork's own extended end.
  //
  // The two edges are extended along their own slopes, so they converge and
  // eventually cross: the strip becomes a bowtie far outside the head. Measured,
  // the earliest crossing over the live yaw range is x = 902 on the right, 102
  // units past the rim, and x = -180 on the left. The widest silhouette the rig
  // draws is the success diamond at x = 844, and the mask insets even that, so
  // nothing paintable reaches the crossing and the strip is never thinner than
  // 14 units where it can be seen. A wider shape, or a larger reach, would bring
  // the bowtie into view — extend both edges on one shared slope if that day
  // comes. `head.test.ts` pins the safe span.
  const extend = (edge: Point[], atStart: boolean): Point => {
    const near = atStart ? edge[0]! : edge[edge.length - 1]!;
    const back = atStart ? edge[RING_BASELINE]! : edge[edge.length - 1 - RING_BASELINE]!;
    const slope = clamp((near.y - back.y) / (near.x - back.x || 1), -RING_SLOPE, RING_SLOPE);
    const dx = atStart ? -RING_REACH : RING_REACH;
    return { x: near.x + dx, y: near.y + slope * dx };
  };
  const top = [extend(topEdge, true), ...topEdge, extend(topEdge, false)];
  const bottom = [extend(bottomEdge, true), ...bottomEdge, extend(bottomEdge, false)];
  return [
    { cmd: "M", points: [top[0]!] },
    ...top.slice(1).map((p) => ({ cmd: "L" as const, points: [p] })),
    ...bottom.reverse().map((p) => ({ cmd: "L" as const, points: [p] })),
  ];
}

/** How far past the head sphere's rim the band carries on, in head space. */
export const RING_REACH = 420;
/** How many ring samples back the slope of the extension is read from, and the steepest it may be. */
export const RING_BASELINE = 6;
export const RING_SLOPE = 0.6;
