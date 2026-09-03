/**
 * The measurements the tests share.
 *
 * A silhouette is a set of closed splines, so almost every claim in this suite
 * is about a point set: how far it is from another one, how large its box is,
 * and whether two of them carry the same command list.
 */

import { flatten, type Point, type Segment } from "../src/geometry.ts";

/** The command list of a path. Two paths blend only when these agree. */
export function signature(segments: readonly Segment[]): string {
  return segments.map((segment) => `${segment.cmd}${segment.points.length}`).join("");
}

/** The on-curve points of a closed spline: the start, then the end of each cubic. */
export function onCurve(segments: readonly Segment[]): Point[] {
  return segments.slice(1).map((segment) => segment.points[segment.points.length - 1]!);
}

/** The shortest distance from a point to a closed polyline. */
export function distanceToLoop(point: Point, loop: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const square = dx * dx + dy * dy;
    const along =
      square === 0 ? 0 : Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / square));
    const distance = Math.hypot(point.x - (a.x + dx * along), point.y - (a.y + dy * along));
    if (distance < best) best = distance;
  }
  return best;
}

export interface Box {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export function boxOf(points: readonly Point[]): Box {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { minX, maxX, minY, maxY };
}

/** Every point of every loop of a silhouette, as one dense polyline sample. */
export function pointsOf(loops: readonly (readonly Segment[])[], perSegment = 8): Point[] {
  return loops.flatMap((loop) => flatten(loop, perSegment));
}

/** Twice the signed area of a closed loop. Screen y runs down, so clockwise is positive. */
export function twiceSignedArea(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    total += a.x * b.y - b.x * a.y;
  }
  return total;
}

/** The distance from each point of a closed loop to the next one. */
export function gaps(points: readonly Point[]): number[] {
  return points.map((point, i) => {
    const next = points[(i + 1) % points.length]!;
    return Math.hypot(next.x - point.x, next.y - point.y);
  });
}
