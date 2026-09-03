/**
 * Error: an exclamation mark, shaking its head.
 *
 * The universal error glyph, and the one place a glyph is right: it says
 * exactly one thing. The band goes amber on top of it so the alarm carries in
 * colour too. It arrives shaking its head "no", and while held the mark is
 * thumped once a cycle — the bar drops, the point swells — with another shake
 * of the head through the same beat.
 */

import { AMBER } from "../art.ts";
import { LIMIT, NO_BODY } from "../motion.ts";
import { CENTRE, dotAt, roundedPolygonLoop, split, toSpline } from "../shapes.ts";
import { NO_GESTURE, move, rise, type Beat, type StateDefinition } from "./definition.ts";

/** The exclamation mark: a bar with rounded ends, and a dot under it. */
const BANG = { halfWidth: 96, top: 172, barBottom: 632, dotY: 792, dotR: 78 } as const;
/** The thump-and-shake cycle, in seconds. */
const CYCLE = 2.2;
/** The thump: how far the bar drops, how far the point drops and swells. */
const THUMP = { barDrop: 7, pointDrop: 10, pointSwell: 0.3 } as const;
/** The held "no": how far the head swings, and how many swings a cycle. */
const SHAKE = { turn: 0.3, swings: 4 } as const;
/** The arrival "no": three swings decaying, this many milliseconds apart. */
const ARRIVAL_SWINGS: readonly number[] = [-0.6, 0.45, -0.25];
const SWING_EVERY = 110;

/**
 * Amber, not coral.
 *
 * Coral is the error colour in the palette, but it is also the app-icon tile —
 * a coral band on a coral tile disappears, and the tails read as holes punched
 * in the shape. Amber carries the same alarm and holds against both the tile
 * and a dark surface.
 */
const BAND = AMBER;

/** The head shakes, three swings decaying, and the body follows a little. Never a loop. */
const SHAKE_NO: readonly Beat[] = [
  {
    at: 0,
    apply: (self) => {
      self.squash.target = LIMIT.bodySquash * 0.6;
      self.turnTo(ARRIVAL_SWINGS[0]! * self.direction);
      self.lean.target = -LIMIT.bodyLean * 0.4 * self.direction;
    },
  },
  {
    at: SWING_EVERY,
    apply: (self) => {
      self.turnTo(ARRIVAL_SWINGS[1]! * self.direction);
      self.lean.target = LIMIT.bodyLean * 0.3 * self.direction;
    },
  },
  {
    at: SWING_EVERY * 2,
    apply: (self) => {
      self.turnTo(ARRIVAL_SWINGS[2]! * self.direction);
      self.lean.target = -LIMIT.bodyLean * 0.15 * self.direction;
    },
  },
  {
    at: SWING_EVERY * 3,
    apply: (self) => {
      self.homeTurn();
      self.lean.target = 0;
      self.squash.target = 0;
    },
  },
];

export const error: StateDefinition = {
  silhouette: {
    // The bar, then the dot that drops off it.
    loops: split([
      toSpline(
        roundedPolygonLoop(
          [
            { x: CENTRE.x - BANG.halfWidth, y: BANG.top },
            { x: CENTRE.x + BANG.halfWidth, y: BANG.top },
            { x: CENTRE.x + BANG.halfWidth, y: BANG.barBottom },
            { x: CENTRE.x - BANG.halfWidth, y: BANG.barBottom },
          ],
          BANG.halfWidth,
        ),
        { x: CENTRE.x, y: (BANG.top + BANG.barBottom) / 2 },
      ),
      dotAt(CENTRE.x, BANG.dotY, BANG.dotR),
    ]),
    // The face rides the bar, high up where the eye goes first.
    face: { x: 490, y: 372, spread: 34, scale: 0.3, knot: { x: 578, y: 322 }, tailScale: 0.32, rides: 0 },
  },
  expression: {
    // The deepest scowl: brows down and knitted, eyes open, gaze dropped.
    brow: { innerDrop: 52, lift: -2, bow: -6 },
    browSkew: 4,
    eyeOpen: 0.96,
    gaze: { x: 0, y: 0.25 },
    turn: 0,
    body: NO_BODY,
  },
  band: BAND,
  life: { period: CYCLE, breathe: 0.04, sway: 0, hemDrift: 0, gazeWander: 0.05 },
  bandSpin: 0,
  entry: SHAKE_NO,
  gesture: (phase, weight) => {
    // Once a cycle the mark is thumped — the bar drops, the point swells and
    // drops with it — and the head shakes "no" through the same window: a few
    // quick swings under a rise-and-fall envelope, then still until the next
    // cycle. Cubed, so the thump is sharp and the rest is long.
    const window = rise(Math.sin(phase));
    const beat = window ** 3;
    const shake = Math.sin(phase * SHAKE.swings) * window;
    const point = move({ x: 0, y: THUMP.pointDrop * beat }, 1 + THUMP.pointSwell * beat, weight);
    return {
      ...NO_GESTURE,
      loops: [move({ x: 0, y: THUMP.barDrop * beat }, 1, weight), point, point],
      turn: shake * SHAKE.turn * weight,
    };
  },
};
