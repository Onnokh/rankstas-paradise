/**
 * Thinking: a circle with the headband turning round it.
 *
 * The knot and tails travel slowly round the head, go round the back and come
 * out the other side, over and over. It reads as machinery turning inside the
 * head, and nothing else has it. The head sways with the turn once per
 * revolution and the eyes look up and follow the sway.
 *
 * The circle is the dome's own radius, so the band ring built for the ghost's
 * head fits it exactly and the knot surfaces at the body's rim, never through
 * the face. The face keeps the ghost's proportions and its place left of
 * centre, which puts the ring's axis on the circle's centre.
 */

import { ACID, FRAME } from "../art.ts";
import { NO_BODY } from "../motion.ts";
import { CENTRE, GHOST_FACE, circleLoop, toSpline, whole } from "../shapes.ts";
import { CHANGE, NO_GESTURE, type StateDefinition } from "./definition.ts";

/**
 * One revolution in five seconds — slow and steady, so it reads as a mechanism
 * at work and not a bandana coming loose. The breath has the same period, so
 * the sway below stays locked to the turn.
 */
const REVOLUTION = 5;
/** How far the head sways with the turn, and how far the eyes follow the sway. */
const SWAY = 0.3;
const FOLLOW = 0.45;

export const thinking: StateDefinition = {
  silhouette: {
    loops: whole(toSpline(circleLoop(CENTRE.x, CENTRE.y, FRAME.halfWidth))),
    face: {
      x: GHOST_FACE.x,
      y: 582,
      spread: GHOST_FACE.spread,
      scale: 0.95,
      knot: { x: GHOST_FACE.knot.x, y: 464 },
      // Full size, or the knot's travel is scaled about the knot and it would
      // surface short of the rim.
      tailScale: 1,
      rides: 0,
    },
  },
  expression: {
    // Thinking hard: one brow up and one down, eyes narrowed and looking up.
    brow: { innerDrop: 34, lift: 3, bow: 2 },
    browSkew: 12,
    eyeOpen: 0.86,
    gaze: { x: 0, y: -0.6 },
    turn: 0,
    body: NO_BODY,
  },
  band: ACID,
  life: { period: REVOLUTION, breathe: 0.08, sway: 2, hemDrift: 2, gazeWander: 0.06 },
  bandSpin: (Math.PI * 2) / REVOLUTION,
  entry: CHANGE,
  gesture: (phase, weight) => {
    const sway = Math.sin(phase);
    return {
      ...NO_GESTURE,
      turn: sway * SWAY * weight,
      gaze: { x: sway * FOLLOW * weight, y: 0 },
    };
  },
};
