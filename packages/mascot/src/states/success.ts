/**
 * Success: a diamond, hopping for joy.
 *
 * Joy is jumping in every culture, and the diamond is the shape with a point
 * to jump on. It hops the whole time it is held — a stretch in the air, a
 * press on landing, the head wiggling with it — and winks once a cycle. The
 * character celebrates rather than turning into a symbol.
 */

import { ACID } from "../art.ts";
import { LIMIT, NO_BODY } from "../motion.ts";
import { regular, roundedPolygonLoop, toSpline, whole } from "../shapes.ts";
import { NO_GESTURE, rise, type StateDefinition } from "./definition.ts";

/** Four hops a cycle, and one wink a cycle. */
const CYCLE = 3.4;
const HOPS = 4;
/** How high a hop goes, in viewBox units, and the landing press and in-air stretch as fractions of the squash limit. */
const HOP = { height: 36, land: 0.6, stretch: 0.4 } as const;
/** How far the head wiggles with the hops, as a turn of 0 to 1. */
const WIGGLE = 0.1;
/** The wink: how much of the cycle the lid is down, and how far it closes. */
const WINK = { window: 0.08, close: 0.96 } as const;
/** A press before the first hop, in milliseconds. */
const PRESS = 120;

export const success: StateDefinition = {
  silhouette: {
    loops: whole(toSpline(roundedPolygonLoop(regular(4, 380, 0), 74))),
    // The diamond is widest at its middle, so the face can be nearly full size.
    face: { x: 490, y: 556, spread: 96, scale: 0.86, knot: { x: 800, y: 462 }, tailScale: 0.9, rides: 0 },
  },
  expression: {
    // Beaming: the happy squint, brows lifted a little and softened, but still
    // the character's brows.
    brow: { innerDrop: 26, lift: 8, bow: 8 },
    browSkew: 0,
    eyeOpen: 0.7,
    gaze: { x: 0, y: -0.2 },
    turn: 0,
    body: NO_BODY,
  },
  band: ACID,
  life: { period: CYCLE, breathe: 0.1, sway: 3, hemDrift: 3, gazeWander: 0.08 },
  bandSpin: 0,
  // A press before the first hop. The hopping itself is the held gesture, and
  // it fades in as the shape arrives.
  entry: [
    { at: 0, apply: (self) => void (self.squash.target = LIMIT.bodySquash) },
    { at: PRESS, apply: (self) => void (self.squash.target = 0) },
  ],
  gesture: (phase, weight) => {
    // Each hop is a half sine off the floor. The press lands just after
    // touchdown and is gone before the next hop.
    const beat = phase * HOPS;
    const air = rise(Math.sin(beat));
    const landing = rise(-Math.sin(beat)) ** 6;
    // The lid drops for a short window near the top of the cycle and comes back.
    const window = rise((Math.sin(phase) - (1 - WINK.window)) / WINK.window);
    return {
      ...NO_GESTURE,
      turn: Math.sin(beat / 2) * WIGGLE * weight,
      wink: 1 - WINK.close * window * weight,
      lift: HOP.height * air * weight,
      squash: (HOP.land * landing - HOP.stretch * air) * weight,
    };
  },
};
