/**
 * Idle: the ghost, as drawn.
 *
 * At rest the character is the brand icon and has nothing to say, so it says
 * nothing: it breathes, sways, stirs its hem, lets its eyes wander, blinks now
 * and then, and slowly turns its head to look around.
 */

import { ACID } from "../art.ts";
import { NO_BODY } from "../motion.ts";
import { GHOST_FACE, GHOST_SPLINE, whole } from "../shapes.ts";
import { CHANGE, NO_GESTURE, look, type StateDefinition } from "./definition.ts";

/** How far the head drifts while looking around, as a turn of 0 to 1. */
const LOOK = 0.16;

export const idle: StateDefinition = {
  silhouette: { loops: whole(GHOST_SPLINE), face: GHOST_FACE },
  expression: {
    // The brand face: the scowl, round eyes, looking straight out.
    brow: { innerDrop: 46, lift: 0, bow: 0 },
    browSkew: 0,
    eyeOpen: 1,
    gaze: { x: 0, y: 0 },
    turn: 0,
    // Rest is the artwork, untouched.
    body: NO_BODY,
  },
  band: ACID,
  life: { period: 4.6, breathe: 0.1, sway: 3, hemDrift: 2.6, gazeWander: 0.1 },
  bandSpin: 0,
  entry: CHANGE,
  gesture: (phase, weight) => ({ ...NO_GESTURE, turn: look(phase) * LOOK * weight }),
};
