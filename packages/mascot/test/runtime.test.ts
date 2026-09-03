/**
 * The runtime: `createMascot` and everything that only exists once the rig is
 * running.
 *
 * The other suites test pure layers, and they can, because nothing there needs
 * a document. This one is the layer that builds an SVG, reads its own markup
 * back, and drives it from a frame loop, so it runs the real `Runtime` against
 * the test double in `fake-dom.ts`. Read that file's limits before adding a
 * claim here: the double has no layout, no clipping, and no masking, so every
 * assertion below has to be about what the rig emits, never about what a
 * browser would then do with it.
 *
 * Three of these are defects that reached the screen: a mascot built straight
 * into `error` drawing the acid band it was leaving, a new mascot standing
 * still for up to nine seconds because the loop waited for the first blink,
 * and a change's glance pulling a head the application was holding off the yaw
 * it asked for.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { ACID, AMBER, BODY_REST } from "../src/art.ts";
import { emitPath, parsePath, parseHex, rgbCss, type Point, type Segment } from "../src/geometry.ts";
import { createMascot } from "../src/index.ts";
import { LIMIT, TURN } from "../src/motion.ts";
import type { FaceLayout } from "../src/shapes.ts";
import { STATE, STATES } from "../src/states/index.ts";
import type { Mascot, MascotOptions, MascotState } from "../src/types.ts";
import { createFakeDom, fakeOf, query, type FakeDom, type FakeElement } from "./fake-dom.ts";
import { boxOf, distanceToLoop, onCurve } from "./support.ts";

// ----------------------------------------------------------------- fixtures

/**
 * Every fake DOM this test made, newest first.
 *
 * `createFakeDom` replaces `Math.random` and installs `CSS`, so each one has to
 * be put back, and in the reverse order of creation when a test holds two.
 */
const live: FakeDom[] = [];

function fresh(): FakeDom {
  const dom = createFakeDom();
  live.unshift(dom);
  return dom;
}

afterEach(() => {
  for (const dom of live) dom.restore();
  live.length = 0;
});

function mascotIn(dom: FakeDom, options: MascotOptions): Mascot {
  return createMascot(dom.host, options);
}

/** The colour the band carries, as the rig writes it. */
function bandColour(mascot: Mascot): string {
  return query(mascot.element, ".rk-band").getAttribute("fill") ?? "";
}

const REST_COLOUR = rgbCss(parseHex(ACID));
const ALARM_COLOUR = rgbCss(parseHex(AMBER));

function expectedBand(state: MascotState): string {
  return rgbCss(parseHex(STATE[state].band));
}

/** The silhouette on screen, one point set per loop. */
function drawnLoops(mascot: Mascot): Point[][] {
  const d = query(mascot.element, ".rk-body-shape").getAttribute("d") ?? "";
  return d
    .split(/(?=M)/)
    .filter((piece) => piece.length > 1)
    .map((piece) => onCurve(parsePath(piece)));
}

/**
 * The shape a state shows.
 *
 * A cycling state enters on the first frame of its cycle, and holds its still
 * frame — the ellipsis — when nothing may move.
 */
function shapeOf(state: MascotState, suppressed: boolean): {
  loops: readonly (readonly Segment[])[];
  face: FaceLayout;
} {
  const definition = STATE[state];
  return definition.cycle !== undefined && !suppressed ? definition.cycle.frames[0]! : definition.silhouette;
}

/** The on-curve outline of every loop of a silhouette, worked out once per silhouette. */
const outlines = new WeakMap<readonly (readonly Segment[])[], Point[][]>();

function outlinesOf(loops: readonly (readonly Segment[])[]): Point[][] {
  const held = outlines.get(loops);
  if (held !== undefined) return held;
  const made = loops.map((loop) => onCurve(loop));
  outlines.set(loops, made);
  return made;
}

/** How far the furthest drawn point is from the nearest of a set of loops. */
function reachFrom(points: readonly Point[], loops: readonly (readonly Segment[])[]): number {
  const outlines = outlinesOf(loops);
  let worst = 0;
  for (const point of points) {
    let nearest = Infinity;
    for (const outline of outlines) nearest = Math.min(nearest, distanceToLoop(point, outline));
    if (nearest > worst) worst = nearest;
  }
  return worst;
}

/**
 * How far the drawn silhouette may sit off the shape it holds.
 *
 * A held state is never still, so an arrived shape is the state's own outline
 * plus whatever its gesture and its breath are doing to it. The widest of them
 * is `error`'s thump, which swells the point by 30 % of its 78-unit radius and
 * drops it 10 — about 33 units. Measured worst over all twenty changes: 32.
 * Every one of those same changes leaves the shape it came from at 45 units or
 * more, so this separates arrival from a morph that never ran.
 */
const GESTURE_REACH = 38;

/** Where the eyes sit, and how far apart. This is the face layout, as drawn. */
function eyesOf(mascot: Mascot): { x: number; y: number; spread: number } {
  const centres = fakeOf(mascot.element)
    .querySelectorAll(".rk-eye")
    .map((eye) => {
      const box = boxOf(onCurve(parsePath(eye.getAttribute("d") ?? "")));
      return { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
    });
  const [left, right] = centres as [{ x: number; y: number }, { x: number; y: number }];
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
    spread: Math.abs(right.x - left.x) / 2,
  };
}

/**
 * How far the eye pair may sit off the layout the state names.
 *
 * The eyes carry the gaze and slide with the head: the gaze alone is 26 units
 * across and 14 down, and a yaw slides the whole face across the sphere on top
 * of that. Measured worst across a second of every state: 56 across, 13 down,
 * both while `thinking` sways with its band. The five layouts are 194 units
 * apart at the extremes, so this still names one of them.
 */
const FACE_REACH = { x: 70, y: 20 };
/** The spread is the layout's own, narrowed only by the foreshortening of a turn. Measured worst: 1.35. */
const SPREAD_REACH = 1.5;

/**
 * Every number the rig draws with, in one string.
 *
 * The generated attributes only: enough to catch a NaN anywhere in a frame,
 * and to compare two runs frame for frame. The per-instance ids are left out,
 * because two mascots on one page never share them.
 */
const DRAWN = ["d", "cx", "cy", "r", "stroke-width", "fill"] as const;

function drawnValues(mascot: Mascot): string {
  return fakeOf(mascot.element)
    .descendants()
    .map(
      (part) =>
        DRAWN.map((name) => part.getAttribute(name) ?? "").join(" ") + (part.style["transform"] ?? ""),
    )
    .join("|");
}

/** The same values, scanned in place. Cheap enough to run on every frame of a change. */
function drawsNaN(mascot: Mascot): boolean {
  for (const part of fakeOf(mascot.element).descendants()) {
    for (const name of DRAWN) if (part.getAttribute(name)?.includes("NaN") === true) return true;
    if (part.style["transform"]?.includes("NaN") === true) return true;
  }
  return false;
}

/**
 * How far a settled shape may sit off the silhouette it holds.
 *
 * Under reduced motion every spring is on its target, so the only difference
 * left is the resampling: the ghost holds the artwork to 0.53 of a unit at the
 * worst place on the curve between its 128 points. Measured worst here, on the
 * polyline this suite samples with: 1.2.
 */
const SETTLED_REACH = 1.5;

// ------------------------------------------------------------- construction

describe("a mascot built straight into a state shows that state", () => {
  // Until this was fixed, the constructor never settled its springs, so a
  // mascot built while motion was suppressed drew the state it was leaving:
  // `error` with the acid band of `idle`, which is the one state that says
  // something in colour.
  for (const suppressed of [false, true]) {
    const motion = suppressed ? "with motion suppressed" : "with motion allowed";

    for (const state of STATES) {
      test(`${state} ${motion} draws its own silhouette, face, and band`, () => {
        const dom = fresh();
        const mascot = mascotIn(dom, { state, reducedMotion: suppressed });
        // The band tint is a 130 ms spring, so with motion allowed the colour
        // is given a moment to arrive; suppressed, it is settled already.
        if (!suppressed) dom.advance(300);

        const shape = shapeOf(state, suppressed);
        expect(reachFrom(drawnLoops(mascot).flat(), shape.loops)).toBeLessThanOrEqual(GESTURE_REACH);

        const eyes = eyesOf(mascot);
        expect(Math.abs(eyes.x - shape.face.x)).toBeLessThanOrEqual(FACE_REACH.x);
        expect(Math.abs(eyes.y - shape.face.y)).toBeLessThanOrEqual(FACE_REACH.y);
        expect(Math.abs(eyes.spread - shape.face.spread)).toBeLessThanOrEqual(SPREAD_REACH);

        expect(bandColour(mascot)).toBe(expectedBand(state));
      });
    }
  }

  test("error built with motion suppressed carries amber, not the acid it left", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "error", reducedMotion: true });
    expect(bandColour(mascot)).toBe(ALARM_COLOUR);
    expect(ALARM_COLOUR).not.toBe(REST_COLOUR);
  });
});

describe("the render loop starts at construction", () => {
  // It used to start on the first blink, which is 4 to 9 seconds away, so a
  // new mascot stood completely still until then.
  for (const state of STATES) {
    test(`${state} holds a frame the moment it is built`, () => {
      const dom = fresh();
      mascotIn(dom, { state });
      expect(dom.pending.frames).toBe(1);
      // And keeps holding one: the loop re-arms itself every frame.
      dom.advance(100);
      expect(dom.pending.frames).toBe(1);
    });

    test(`${state} holds no frame when motion is suppressed`, () => {
      const dom = fresh();
      mascotIn(dom, { state, reducedMotion: true });
      expect(dom.pending.frames).toBe(0);
      expect(dom.pending.timeouts).toBe(0);
    });
  }
});

// --------------------------------------------------------------- held state

describe("a held state is not a still frame", () => {
  /**
   * Enough of the state's own clock for the slowest of them to move.
   * `loading` changes on its 640 ms cycle tick; the others change through
   * their gesture and their breath, which are continuous.
   */
  const HOLD = 700;

  for (const state of STATES) {
    test(`${state} draws a different silhouette after ${HOLD} ms of frames`, () => {
      const dom = fresh();
      const mascot = mascotIn(dom, { state });
      dom.advance(300);
      const before = query(mascot.element, ".rk-body-shape").getAttribute("d");
      dom.advance(HOLD);
      expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).not.toBe(before);
    });
  }
});

// ------------------------------------------------------------ state changes

describe("every state change lands", () => {
  /** Long enough for the source shape and its band to settle before the change. */
  const SETTLE = 400;
  /** A morph is 99 % done in 420 ms, and the longest arrival beat ends at 330 ms. */
  const ARRIVAL = 500;

  for (const from of STATES) {
    for (const to of STATES) {
      if (from === to) continue;

      test(`${from} into ${to} arrives at the shape and the colour`, () => {
        const dom = fresh();
        const mascot = mascotIn(dom, { state: from });
        dom.advance(SETTLE);
        mascot.setState(to);

        // Every frame of the change, not just the ends: a NaN anywhere in the
        // run blanks a path on screen and never shows up in the last frame.
        for (let elapsed = 0; elapsed < ARRIVAL; elapsed += 1000 / 60) {
          dom.advance(1000 / 60);
          expect(drawsNaN(mascot)).toBe(false);
        }

        expect(mascot.state).toBe(to);
        const points = drawnLoops(mascot).flat();
        expect(reachFrom(points, shapeOf(to, false).loops)).toBeLessThanOrEqual(GESTURE_REACH);
        // And it really left the other shape, rather than sitting between them.
        expect(reachFrom(points, shapeOf(from, false).loops)).toBeGreaterThan(GESTURE_REACH);
        expect(bandColour(mascot)).toBe(expectedBand(to));
      });
    }
  }
});

// ------------------------------------------------------------ reduced motion

describe("reduced motion holds a still shape", () => {
  /** The artwork as the rig emits it: the same shape, at the rig's own two decimals. */
  const ARTWORK = emitPath(parsePath(BODY_REST));

  test("idle at rest re-emits the source artwork", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "idle", reducedMotion: true });
    expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).toBe(ARTWORK);
  });

  test("idle re-emits the artwork again after a round trip through other states", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "idle", reducedMotion: true });
    mascot.setState("error");
    mascot.setState("loading");
    mascot.setState("idle");
    expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).toBe(ARTWORK);
  });

  test("the cycling state holds its still frame, the ellipsis", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "loading", reducedMotion: true });
    const ellipsis = STATE.loading.silhouette.loops.map((loop) => emitPath(loop)).join("");
    expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).toBe(ellipsis);

    // And keeps holding it: the cycle timer is not running at all.
    dom.advance(3000);
    expect(dom.pending.timeouts).toBe(0);
    expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).toBe(ellipsis);
  });

  for (const state of STATES) {
    test(`a change into ${state} settles with no travel`, () => {
      const dom = fresh();
      const mascot = mascotIn(dom, { state: state === "idle" ? "error" : "idle", reducedMotion: true });
      mascot.setState(state);
      const landed = query(mascot.element, ".rk-body-shape").getAttribute("d");

      // The shape is the state's own, arrived whole. A change carries a twist,
      // so the emitted string starts at another point of the same outline;
      // the claim is about the shape, not about where its spline begins.
      expect(reachFrom(drawnLoops(mascot).flat(), shapeOf(state, true).loops)).toBeLessThanOrEqual(
        SETTLED_REACH,
      );

      // Nothing is scheduled, so nothing can travel.
      expect(dom.pending.frames).toBe(0);
      expect(dom.pending.timeouts).toBe(0);
      dom.advance(2000);
      expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).toBe(landed);
    });
  }

  test("blinking stops", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "idle", reducedMotion: true });
    const before = fakeOf(mascot.element)
      .querySelectorAll(".rk-eye")
      .map((eye) => eye.getAttribute("d"));

    // No timer is waiting to blink, and an asked-for blink is refused.
    expect(dom.pending.timeouts).toBe(0);
    mascot.blink();
    dom.advance(10_000);
    expect(dom.pending.timeouts).toBe(0);
    expect(
      fakeOf(mascot.element)
        .querySelectorAll(".rk-eye")
        .map((eye) => eye.getAttribute("d")),
    ).toEqual(before);
  });
});

// ------------------------------------------------------ the motion context

describe("the motion context stops and restarts the loop", () => {
  /**
   * A frame is already in flight when motion is suppressed, and the rig does
   * not cancel it: the tick returns at once and does not re-arm. So the loop
   * is measured one frame later.
   */
  const ONE_FRAME = 100;

  for (const [name, suppress] of [
    ["reduced motion", (dom: FakeDom, on: boolean) => dom.reduceMotion(on)],
    ["a hidden document", (dom: FakeDom, on: boolean) => dom.hide(on)],
  ] as const) {
    test(`${name} stops the loop mid-animation and leaves a readable shape`, () => {
      const dom = fresh();
      const mascot = mascotIn(dom, { state: "success" });
      dom.advance(500);

      suppress(dom, true);
      dom.advance(ONE_FRAME);
      expect(dom.pending.frames).toBe(0);
      expect(dom.pending.timeouts).toBe(0);

      const held = query(mascot.element, ".rk-body-shape").getAttribute("d") ?? "";
      expect(held.length).toBeGreaterThan(0);
      expect(drawsNaN(mascot)).toBe(false);
      dom.advance(2000);
      expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).toBe(held);
    });

    test(`${name} restores the loop when it is lifted`, () => {
      const dom = fresh();
      const mascot = mascotIn(dom, { state: "success" });
      dom.advance(500);
      suppress(dom, true);
      dom.advance(ONE_FRAME);

      suppress(dom, false);
      // The loop and the blink timer are both back.
      expect(dom.pending.frames).toBe(1);
      expect(dom.pending.timeouts).toBe(1);
      const before = query(mascot.element, ".rk-body-shape").getAttribute("d");
      dom.advance(300);
      expect(query(mascot.element, ".rk-body-shape").getAttribute("d")).not.toBe(before);
    });
  }

  test("a cycling state picks its cycle back up", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "loading" });
    dom.advance(500);
    dom.reduceMotion(true);
    dom.advance(100);
    const ellipsis = STATE.loading.silhouette.loops;
    expect(reachFrom(drawnLoops(mascot).flat(), ellipsis)).toBeLessThanOrEqual(SETTLED_REACH);

    // Back on the cycle: the first frame of it, which is the triangle, and a
    // tick waiting to carry it to the next.
    dom.reduceMotion(false);
    dom.advance(500);
    const points = drawnLoops(mascot).flat();
    expect(reachFrom(points, STATE.loading.cycle!.frames[0]!.loops)).toBeLessThanOrEqual(GESTURE_REACH);
    expect(reachFrom(points, ellipsis)).toBeGreaterThan(GESTURE_REACH);
    expect(dom.pending.timeouts).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- the turn

describe("the application can hold the head", () => {
  test("turnHead moves the face and releaseTurn puts it back exactly", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "idle", reducedMotion: true });
    const rest = eyesOf(mascot);

    mascot.turnHead(0.6);
    const turned = eyesOf(mascot);
    // A positive yaw turns to the viewer's right, so the face slides right.
    expect(turned.x).toBeGreaterThan(rest.x + 1);

    mascot.releaseTurn();
    expect(eyesOf(mascot)).toEqual(rest);
  });

  test("a yaw past the bound is the bound", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "idle", reducedMotion: true });
    mascot.turnHead(5);
    const clamped = drawnValues(mascot);
    mascot.turnHead(1);
    expect(drawnValues(mascot)).toBe(clamped);
    // The bound is a yaw of 1, which the head model reads as 45 degrees.
    expect(TURN.degrees).toBe(45);
  });

  test("a state change's glance does not move a head the application holds", () => {
    // The change beat glances aside through `turnTo`, which a held head
    // refuses. Writing the spring target instead pulled the head off the yaw
    // the application asked for until the glance decayed, 320 ms later.
    //
    // Two identical runs: one that asks for the yaw once, and one that asks
    // for it again on every frame of the arrival. If the glance moved the
    // head at all, the frames would part.
    const trace = (reassert: boolean): string => {
      const dom = fresh();
      const mascot = mascotIn(dom, { state: "idle" });
      mascot.turnHead(0.6);
      dom.advance(500);
      // `error` is the strongest case: its arrival shakes its head "no".
      mascot.setState("error");
      const frames: string[] = [];
      for (let i = 0; i < 30; i++) {
        dom.advance(1000 / 60);
        if (reassert) mascot.turnHead(0.6);
        frames.push(drawnValues(mascot));
      }
      mascot.destroy();
      return frames.join("\n");
    };

    expect(trace(false)).toBe(trace(true));
  });
});

// ---------------------------------------------------------------- the gaze

describe("lookAtPoint aims from the face layout in force", () => {
  /**
   * The element is given the canvas's own size, so a client coordinate is a
   * viewBox unit and the arithmetic is readable: the ghost wears its face at
   * y 566 and the exclamation mark wears its own at y 372, so a point at 470
   * is above the one and below the other.
   */
  const BOX = { left: 0, top: 0, width: 1024, height: 1024 };
  const AIM = { x: 512, y: 470 };
  /** The gaze bound is 14 units down, scaled by the layout. Well clear of the noise at two decimals. */
  const READABLE = 0.3;

  for (const [state, sense] of [
    ["idle", -1],
    ["error", 1],
  ] as const) {
    test(`${state} looks ${sense < 0 ? "up" : "down"} at the same point`, () => {
      const dom = fresh();
      // Two mascots on the same clock, so the breath is at the same phase in
      // both and the only difference between them is the aim.
      const aimed = mascotIn(dom, { state });
      const centred = mascotIn(dom, { state });
      for (const mascot of [aimed, centred]) fakeOf(mascot.element).box = { ...BOX };
      dom.advance(400);

      aimed.lookAtPoint(AIM.x, AIM.y);
      centred.lookAt({ x: 0, y: 0 });
      dom.advance(400);

      const shift = eyesOf(aimed).y - eyesOf(centred).y;
      expect(Math.sign(shift)).toBe(sense);
      expect(Math.abs(shift)).toBeGreaterThan(READABLE);
      expect(Math.abs(shift)).toBeLessThanOrEqual(LIMIT.gazeY);
    });
  }

  test("an element with no box is not aimed at all", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "idle", reducedMotion: true });
    fakeOf(mascot.element).box = { left: 0, top: 0, width: 0, height: 0 };
    const before = drawnValues(mascot);
    mascot.lookAtPoint(100, 100);
    expect(drawnValues(mascot)).toBe(before);
  });
});

// --------------------------------------------------------------- lifecycle

describe("destroy releases everything", () => {
  test("the frame, both timers, both listeners, and the SVG", () => {
    const dom = fresh();
    const host = fakeOf(dom.host);
    const mascot = mascotIn(dom, { state: "loading" });
    dom.advance(500);
    expect(dom.pending).toEqual({
      frames: 1,
      timeouts: 2, // the blink timer and the cycle timer
      mediaListeners: 1,
      documentListeners: 1,
    });
    expect(host.children).toContain(mascot.element as unknown as FakeElement);

    mascot.destroy();
    expect(dom.pending).toEqual({
      frames: 0,
      timeouts: 0,
      mediaListeners: 0,
      documentListeners: 0,
    });
    expect(host.children).not.toContain(mascot.element as unknown as FakeElement);
  });

  test("nothing draws afterwards", () => {
    const dom = fresh();
    const mascot = mascotIn(dom, { state: "idle" });
    dom.advance(500);
    const last = drawnValues(mascot);

    mascot.destroy();
    dom.advance(2000);
    expect(drawnValues(mascot)).toBe(last);

    // Not even when the application keeps calling.
    mascot.setState("error");
    mascot.turnHead(1);
    mascot.blink();
    dom.advance(2000);
    expect(drawnValues(mascot)).toBe(last);
    expect(dom.pending.frames).toBe(0);
    expect(dom.pending.timeouts).toBe(0);
  });
});
