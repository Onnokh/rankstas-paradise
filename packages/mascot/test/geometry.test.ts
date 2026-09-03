/**
 * Path arithmetic.
 *
 * Everything the rig draws goes through this module, so a fault here is a
 * fault in every state at once.
 */

import { describe, expect, test } from "bun:test";
import { BAND_REST, BODY_REST, TAIL_TOP_REST, VISOR_REST } from "../src/art.ts";
import {
  bendAround,
  closedSpline,
  emitPath,
  flatten,
  lerpPath,
  mixRgb,
  orientClockwise,
  parseHex,
  parsePath,
  resampleClosed,
  rgbCss,
  rotateSpline,
  sampleField,
  smoothstep,
  type Point,
} from "../src/geometry.ts";
import { circleLoop } from "../src/shapes.ts";
import { gaps, onCurve, signature, twiceSignedArea } from "./support.ts";

/**
 * `emitPath` rounds to two decimals, so half of the last place is the most it
 * may lose. The extra millionth is for the float that reports the difference.
 */
const EMIT_PRECISION = 0.005 + 1e-6;

const ARTWORK: readonly (readonly [string, string])[] = [
  ["the body", BODY_REST],
  ["the band", BAND_REST],
  ["the visor", VISOR_REST],
  ["the top tail", TAIL_TOP_REST[0]!],
];

describe("parsePath and emitPath", () => {
  test("a round trip of every artwork path keeps every point", () => {
    for (const [name, d] of ARTWORK) {
      const once = parsePath(d);
      const twice = parsePath(emitPath(once));

      expect(twice.length, name).toBe(once.length);
      expect(signature(twice), name).toBe(signature(once));
      for (let i = 0; i < once.length; i++) {
        const before = once[i]!.points;
        const after = twice[i]!.points;
        expect(after.length, name).toBe(before.length);
        for (let j = 0; j < before.length; j++) {
          expect(Math.abs(after[j]!.x - before[j]!.x), name).toBeLessThanOrEqual(EMIT_PRECISION);
          expect(Math.abs(after[j]!.y - before[j]!.y), name).toBeLessThanOrEqual(EMIT_PRECISION);
        }
      }
    }
  });

  test("a parsed path holds only the four commands a caller can move", () => {
    for (const [, d] of ARTWORK) {
      for (const segment of parsePath(d)) {
        expect(["M", "L", "C", "Q"]).toContain(segment.cmd);
        expect(segment.points.length).toBeGreaterThan(0);
      }
    }
  });

  test("H becomes an L that holds the y, and V becomes an L that holds the x", () => {
    // The band is the one artwork path with H and V in it.
    const segments = parsePath(BAND_REST);
    expect(signature(segments)).toBe("M1L1C3L1C3L1L1");

    // "M40 308.67H241.71" — the H keeps the y of the M before it.
    expect(segments[1]!.points[0]).toEqual({ x: 241.71, y: 308.67 });
    // "…195.981 462.188H40V308.67" — the H keeps the y, then the V keeps that x.
    expect(segments[5]!.points[0]).toEqual({ x: 40, y: 462.188 });
    expect(segments[6]!.points[0]).toEqual({ x: 40, y: 308.67 });
  });

  test("a path with no Z still emits one, because every silhouette loop is closed", () => {
    expect(emitPath(parsePath(BODY_REST))).toEndWith("Z");
    expect(emitPath(parsePath(BODY_REST), false)).not.toEndWith("Z");
  });
});

describe("resampleClosed", () => {
  test("it returns the number of points that was asked for", () => {
    const dense = flatten(parsePath(BODY_REST), 48);
    for (const count of [8, 64, 128, 256]) {
      expect(resampleClosed(dense, count).length).toBe(count);
    }
  });

  test("it spaces the points evenly by arc length", () => {
    // 2 % of the mean gap. Measured on the body, the worst gap is 1.4 % out;
    // a resampler that spaced by index instead of by length is 30 % out.
    const tolerance = 0.02;
    for (const loop of [flatten(parsePath(BODY_REST), 48), circleLoop(500, 500, 200, 512)]) {
      const spacing = gaps(resampleClosed(loop, 128));
      const mean = spacing.reduce((a, b) => a + b, 0) / spacing.length;
      for (const gap of spacing) {
        expect(Math.abs(gap - mean) / mean).toBeLessThan(tolerance);
      }
    }
  });

  test("it puts the resampled points on the outline it was given", () => {
    const dense = circleLoop(500, 500, 200, 512);
    for (const point of resampleClosed(dense, 128)) {
      expect(Math.abs(Math.hypot(point.x - 500, point.y - 500) - 200)).toBeLessThan(0.1);
    }
  });
});

describe("orientClockwise", () => {
  // Blend a clockwise loop with a counter-clockwise one and the shape folds
  // through itself. The artwork's head circle wound the other way and did it.
  const clockwise = circleLoop(500, 500, 200, 64);
  const counterClockwise = [...clockwise].reverse();

  test("a clockwise loop stays clockwise", () => {
    expect(twiceSignedArea(clockwise)).toBeGreaterThan(0);
    expect(twiceSignedArea(orientClockwise(clockwise))).toBeGreaterThan(0);
  });

  test("a counter-clockwise loop comes out clockwise", () => {
    expect(twiceSignedArea(counterClockwise)).toBeLessThan(0);
    expect(twiceSignedArea(orientClockwise(counterClockwise))).toBeGreaterThan(0);
  });

  test("the body artwork already winds clockwise, so it is left alone", () => {
    const body = flatten(parsePath(BODY_REST), 24);
    expect(twiceSignedArea(body)).toBeGreaterThan(0);
    expect(orientClockwise(body)).toEqual(body);
  });

  test("it keeps every point, and changes only the order", () => {
    const key = (p: Point): string => `${p.x},${p.y}`;
    const out = orientClockwise(counterClockwise);
    expect(out.length).toBe(counterClockwise.length);
    expect([...out].map(key).sort()).toEqual([...counterClockwise].map(key).sort());
  });
});

describe("rotateSpline", () => {
  const spline = closedSpline(circleLoop(500, 500, 200, 64));

  test("it moves the start of the loop", () => {
    const rotated = rotateSpline(spline, 7);
    expect(rotated[0]!.points[0]).not.toEqual(spline[0]!.points[0]);
  });

  test("it keeps the same set of points, so the shape does not change", () => {
    const key = (p: Point): string => `${p.x.toFixed(9)},${p.y.toFixed(9)}`;
    const before = new Set(onCurve(spline).map(key));
    const after = new Set(onCurve(rotateSpline(spline, 7)).map(key));

    expect(after.size).toBe(before.size);
    for (const point of after) expect(before.has(point)).toBe(true);
  });

  test("it keeps the command list, so a rotated loop still blends", () => {
    expect(signature(rotateSpline(spline, 7))).toBe(signature(spline));
  });

  test("a rotation of none, or of a whole turn, changes nothing", () => {
    expect(emitPath(rotateSpline(spline, 0))).toBe(emitPath(spline));
    expect(emitPath(rotateSpline(spline, spline.length - 1))).toBe(emitPath(spline));
  });
});

describe("lerpPath", () => {
  const a = closedSpline(circleLoop(400, 400, 120, 48));
  const b = closedSpline(circleLoop(600, 560, 260, 48));

  test("at 0 it gives the first path back exactly", () => {
    expect(lerpPath(a, b, 0)).toEqual(a);
  });

  test("at 1 it gives the second path back exactly", () => {
    expect(lerpPath(a, b, 1)).toEqual(b);
  });

  test("between the ends every number stays finite", () => {
    for (let i = 0; i <= 20; i++) {
      for (const segment of lerpPath(a, b, i / 20)) {
        for (const point of segment.points) {
          expect(Number.isFinite(point.x)).toBe(true);
          expect(Number.isFinite(point.y)).toBe(true);
        }
      }
    }
  });

  test("it keeps the command list of the first path", () => {
    expect(signature(lerpPath(a, b, 0.37))).toBe(signature(a));
  });
});

describe("smoothstep", () => {
  test("it clamps flat at both ends", () => {
    expect(smoothstep(10, 20, -1000)).toBe(0);
    expect(smoothstep(10, 20, 10)).toBe(0);
    expect(smoothstep(10, 20, 20)).toBe(1);
    expect(smoothstep(10, 20, 1000)).toBe(1);
  });

  test("it rises smoothly through the middle", () => {
    expect(smoothstep(10, 20, 15)).toBeCloseTo(0.5, 12);
    let last = -1;
    for (let i = 0; i <= 40; i++) {
      const value = smoothstep(10, 20, 10 + i / 4);
      expect(value).toBeGreaterThanOrEqual(last);
      last = value;
    }
  });
});

describe("sampleField", () => {
  const stops = [0, 10, 20] as const;
  const values = [1, 2, 3] as const;

  test("it clamps to the first and last value outside the stops", () => {
    expect(sampleField(stops, values, -100)).toBe(1);
    expect(sampleField(stops, values, 0)).toBe(1);
    expect(sampleField(stops, values, 20)).toBe(3);
    expect(sampleField(stops, values, 100)).toBe(3);
  });

  test("it reads a straight line between two stops", () => {
    expect(sampleField(stops, values, 5)).toBeCloseTo(1.5, 12);
    expect(sampleField(stops, values, 15)).toBeCloseTo(2.5, 12);
  });
});

describe("colour", () => {
  const acid = parseHex("#C4FA04");
  const amber = parseHex("#FFB54A");

  test("parseHex reads the three channels", () => {
    expect(acid).toEqual([0xc4, 0xfa, 0x04]);
    expect(parseHex("#000000")).toEqual([0, 0, 0]);
    expect(parseHex("#FFFFFF")).toEqual([255, 255, 255]);
  });

  test("a mix of 1 gives the first colour, and a mix of 0 the second", () => {
    // The order is the other way round from a lerp. A band that read it the
    // wrong way would go amber at rest and acid on an error.
    expect(mixRgb(acid, amber, 1)).toEqual([...acid]);
    expect(mixRgb(acid, amber, 0)).toEqual([...amber]);
  });

  test("a mix feeds its own output back in, so it stays three numbers", () => {
    let colour = amber;
    for (let i = 0; i < 8; i++) colour = mixRgb(acid, colour, 0.3);
    expect(colour.length).toBe(3);
    for (const channel of colour) expect(Number.isFinite(channel)).toBe(true);
    expect(rgbCss(colour)).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
  });
});

describe("bendAround", () => {
  test("a bend below a hundredth of a degree leaves the points where they are", () => {
    // The resting tails must come out bit-identical to the artwork.
    const bend = bendAround({ x: 787.6, y: 441.4 }, 0.005, 148);
    const point = { x: 885.997, y: 336.434 };
    expect(bend(point)).toBe(point);
  });

  test("the far end of the reach turns more than the near end", () => {
    const origin = { x: 0, y: 0 };
    const bend = bendAround(origin, 20, 100);
    const near = bend({ x: 10, y: 0 });
    const far = bend({ x: 100, y: 0 });
    const angle = (p: Point): number => Math.atan2(p.y, p.x);
    expect(Math.abs(angle(near))).toBeLessThan(Math.abs(angle(far)));
    expect((angle(far) * 180) / Math.PI).toBeCloseTo(20, 6);
  });
});
