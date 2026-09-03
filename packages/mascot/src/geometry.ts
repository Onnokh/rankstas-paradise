/**
 * Path arithmetic.
 *
 * The rig does not transform fixed shapes. It rebuilds them. Every expressive
 * part is a function of a few numbers, so any two states have an infinity of
 * shapes between them and the character is never caught interpolating between
 * two stills.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Segment {
  readonly cmd: "M" | "L" | "C" | "Q";
  readonly points: readonly Point[];
}

const NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;

/**
 * Parse absolute path data into segments. `H` and `V` become `L`, so a caller
 * only ever meets four commands and can move every point without special cases.
 */
export function parsePath(d: string): Segment[] {
  const segments: Segment[] = [];
  let cursor: Point = { x: 0, y: 0 };

  for (const token of d.match(/[MLHVCQZ][^MLHVCQZ]*/gi) ?? []) {
    const cmd = token[0]!.toUpperCase();
    const numbers = (token.slice(1).match(NUMBER) ?? []).map(Number);

    if (cmd === "Z") continue;
    if (cmd === "H") {
      cursor = { x: numbers[0]!, y: cursor.y };
      segments.push({ cmd: "L", points: [cursor] });
      continue;
    }
    if (cmd === "V") {
      cursor = { x: cursor.x, y: numbers[0]! };
      segments.push({ cmd: "L", points: [cursor] });
      continue;
    }

    const points: Point[] = [];
    for (let i = 0; i + 1 < numbers.length; i += 2) {
      points.push({ x: numbers[i]!, y: numbers[i + 1]! });
    }
    cursor = points[points.length - 1] ?? cursor;
    segments.push({ cmd: cmd as Segment["cmd"], points });
  }

  return segments;
}

export function emitPath(segments: readonly Segment[], close = true): string {
  const body = segments
    .map((segment) => segment.cmd + segment.points.map((p) => `${round(p.x)} ${round(p.y)}`).join(" "))
    .join("");
  return close ? `${body}Z` : body;
}

/** Move every point of a path, control points included. */
export function mapPath(segments: readonly Segment[], move: (point: Point) => Point): Segment[] {
  return segments.map((segment) => ({ cmd: segment.cmd, points: segment.points.map(move) }));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ------------------------------------------------------------------ fields

/** Ease a value into 0..1 with flat ends, so a displacement field has no seam. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Read a piecewise-linear field sampled at `stops`. */
export function sampleField(stops: readonly number[], values: readonly number[], at: number): number {
  if (at <= stops[0]!) return values[0]!;
  const last = stops.length - 1;
  if (at >= stops[last]!) return values[last]!;
  for (let i = 0; i < last; i++) {
    const a = stops[i]!;
    const b = stops[i + 1]!;
    if (at <= b) {
      const t = (at - a) / (b - a);
      return values[i]! + (values[i + 1]! - values[i]!) * t;
    }
  }
  return values[last]!;
}

/**
 * Bend a shape around an origin instead of rotating it.
 *
 * A point turns by the full angle only at the far end of `reach`; points near
 * the origin barely move. A rigid tail pivots. A bent tail curls.
 */
export function bendAround(origin: Point, degrees: number, reach: number, ease = 1.5) {
  // Below a hundredth of a degree the rotation is smaller than the emitted
  // precision. Skipping it keeps a resting tail bit-identical to the artwork.
  if (Math.abs(degrees) < 0.01) return (point: Point): Point => point;
  const radians = (degrees * Math.PI) / 180;
  return (point: Point): Point => {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const distance = Math.hypot(dx, dy);
    const t = Math.pow(Math.min(1, distance / reach), ease);
    const angle = radians * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: origin.x + dx * cos - dy * sin,
      y: origin.y + dx * sin + dy * cos,
    };
  };
}

// ------------------------------------------------------------------ shapes

const KAPPA = 0.5522847498307936;

/** The shape of one eyebrow, as a stroked curve. */
export interface BrowShape {
  /** How far the inner end sits below the outer end. Large is angry. */
  readonly innerDrop: number;
  /** Both ends up. */
  readonly lift: number;
  /** How far the middle bows away from the straight line. Positive arches up. */
  readonly bow: number;
}

export function browShape(anchor: { outer: Point; inner: Point }, shape: BrowShape): Segment[] {
  const outer = { x: anchor.outer.x, y: anchor.outer.y - shape.lift };
  const inner = { x: anchor.inner.x, y: anchor.outer.y + shape.innerDrop - shape.lift };

  const dx = inner.x - outer.x;
  const dy = inner.y - outer.y;
  const length = Math.hypot(dx, dy) || 1;
  // The bow pushes the control point perpendicular to the brow, so an arch
  // stays an arch whatever angle the brow is holding.
  const control = {
    x: (outer.x + inner.x) / 2 + (dy / length) * shape.bow * Math.sign(dx),
    y: (outer.y + inner.y) / 2 - (dx / length) * shape.bow * Math.sign(dx),
  };

  return [
    { cmd: "M", points: [outer] },
    { cmd: "Q", points: [control, inner] },
  ];
}

/** An ellipse as four cubics, before it is emitted or moved. */
export function ellipseShape(cx: number, cy: number, rx: number, ry: number): Segment[] {
  const ox = rx * KAPPA;
  const oy = ry * KAPPA;
  return [
    { cmd: "M", points: [{ x: cx, y: cy - ry }] },
    { cmd: "C", points: [{ x: cx + ox, y: cy - ry }, { x: cx + rx, y: cy - oy }, { x: cx + rx, y: cy }] },
    { cmd: "C", points: [{ x: cx + rx, y: cy + oy }, { x: cx + ox, y: cy + ry }, { x: cx, y: cy + ry }] },
    { cmd: "C", points: [{ x: cx - ox, y: cy + ry }, { x: cx - rx, y: cy + oy }, { x: cx - rx, y: cy }] },
    { cmd: "C", points: [{ x: cx - rx, y: cy - oy }, { x: cx - ox, y: cy - ry }, { x: cx, y: cy - ry }] },
  ];
}

/**
 * Colour as three numbers.
 *
 * A blend has to feed its own output back in as the start of the next blend,
 * so colour is carried as numbers rather than as a string — which would have
 * to be re-parsed, and would not parse once it came back as `rgb(...)`.
 */
export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** Blend two colours. `t` of 1 is `a`. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [b[0] + (a[0] - b[0]) * t, b[1] + (a[1] - b[1]) * t, b[2] + (a[2] - b[2]) * t];
}

export function rgbCss(colour: Rgb): string {
  return `rgb(${Math.round(colour[0])} ${Math.round(colour[1])} ${Math.round(colour[2])})`;
}

// ------------------------------------------------------------- resampling

/** Evaluate one cubic segment. */
function cubicAt(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

/** Walk a closed path and return a dense polyline of it. */
export function flatten(segments: readonly Segment[], perSegment = 24): Point[] {
  const out: Point[] = [];
  let cursor: Point = { x: 0, y: 0 };
  let start: Point | null = null;

  for (const segment of segments) {
    const last = segment.points[segment.points.length - 1]!;
    if (segment.cmd === "M") {
      cursor = last;
      start ??= last;
      out.push(cursor);
      continue;
    }
    if (segment.cmd === "L") {
      for (let i = 1; i <= perSegment; i++) {
        const t = i / perSegment;
        out.push({ x: cursor.x + (last.x - cursor.x) * t, y: cursor.y + (last.y - cursor.y) * t });
      }
      cursor = last;
      continue;
    }
    if (segment.cmd === "C") {
      const [c1, c2] = segment.points as [Point, Point, Point];
      for (let i = 1; i <= perSegment; i++) out.push(cubicAt(cursor, c1, c2, last, i / perSegment));
      cursor = last;
      continue;
    }
    // A quadratic, promoted to a cubic.
    const [q, end] = segment.points as [Point, Point];
    const c1 = { x: cursor.x + (2 / 3) * (q.x - cursor.x), y: cursor.y + (2 / 3) * (q.y - cursor.y) };
    const c2 = { x: end.x + (2 / 3) * (q.x - end.x), y: end.y + (2 / 3) * (q.y - end.y) };
    for (let i = 1; i <= perSegment; i++) out.push(cubicAt(cursor, c1, c2, end, i / perSegment));
    cursor = end;
  }

  return out;
}

/** Pick `count` points spaced evenly by arc length around a closed polyline. */
export function resampleClosed(dense: readonly Point[], count: number): Point[] {
  const lengths: number[] = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1]!;
    const b = dense[i % dense.length]!;
    lengths.push(lengths[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = lengths[lengths.length - 1]!;

  const out: Point[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const want = (total * i) / count;
    while (cursor < lengths.length - 2 && lengths[cursor + 1]! < want) cursor++;
    const span = lengths[cursor + 1]! - lengths[cursor]!;
    const t = span === 0 ? 0 : (want - lengths[cursor]!) / span;
    const a = dense[cursor]!;
    const b = dense[(cursor + 1) % dense.length]!;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/**
 * A closed Catmull-Rom spline through `points`, as cubics.
 *
 * Two shapes built this way from the same number of points can be blended
 * point by point, which is the whole trick behind a silhouette morph: the
 * command lists match, so there is nothing to reconcile at run time.
 */
export function closedSpline(points: readonly Point[]): Segment[] {
  const n = points.length;
  const at = (i: number): Point => points[((i % n) + n) % n]!;
  const segments: Segment[] = [{ cmd: "M", points: [at(0)] }];

  for (let i = 0; i < n; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    segments.push({
      cmd: "C",
      points: [
        { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
        { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
        p2,
      ],
    });
  }
  return segments;
}

/**
 * Make a closed loop wind clockwise on screen.
 *
 * Two shapes can only be blended point by point if they wind the same way.
 * Blend a clockwise loop with a counter-clockwise one and the shape folds
 * through itself and collapses halfway — which is exactly what the artwork's
 * head circle did against the symbols, because it happens to be drawn the
 * other way round.
 */
export function orientClockwise(points: readonly Point[]): Point[] {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    twiceArea += a.x * b.y - b.x * a.y;
  }
  // Screen coordinates put y downward, so clockwise comes out positive.
  return twiceArea < 0 ? [...points].reverse() : [...points];
}

/** Rotate a closed point loop so it starts at the point nearest `direction`. */
export function alignLoop(points: readonly Point[], centre: Point, direction: Point): Point[] {
  let best = 0;
  let bestDot = -Infinity;
  points.forEach((p, i) => {
    const dx = p.x - centre.x;
    const dy = p.y - centre.y;
    const length = Math.hypot(dx, dy) || 1;
    const dot = (dx / length) * direction.x + (dy / length) * direction.y;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  });
  return [...points.slice(best), ...points.slice(0, best)];
}

/**
 * Shift where a closed spline starts, keeping the same shape.
 *
 * Blending two loops whose start points line up gives a symmetric, slightly
 * dead morph: every point takes the shortest route. Offset one of them and the
 * points travel *around* the outline instead, so the shape twists through the
 * change the way the reference does — without the character ever rotating.
 */
export function rotateSpline(segments: readonly Segment[], by: number): Segment[] {
  const curves = segments.slice(1);
  const n = curves.length;
  if (n === 0) return [...segments];
  const k = ((by % n) + n) % n;
  const rotated = [...curves.slice(k), ...curves.slice(0, k)];
  const start = rotated[rotated.length - 1]!.points[2]!;
  return [{ cmd: "M", points: [start] }, ...rotated];
}

/** Blend two paths that share a command list. */
export function lerpPath(a: readonly Segment[], b: readonly Segment[], t: number): Segment[] {
  return a.map((segment, i) => {
    const other = b[i];
    if (other === undefined) return segment;
    return {
      cmd: segment.cmd,
      points: segment.points.map((p, j) => {
        const q = other.points[j];
        if (q === undefined) return p;
        return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      }),
    };
  });
}
