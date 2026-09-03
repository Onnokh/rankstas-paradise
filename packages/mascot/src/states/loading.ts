/**
 * Loading: a cycle of shapes.
 *
 * On a fixed beat the silhouette jumps to the next shape — triangle, square,
 * bar, play — and the character rides each one. Work in progress is change
 * without arrival, and a spinner would need the rotation the character is not
 * allowed. No two neighbours look alike, so every jump is a jump, and none of
 * the four is another state's shape.
 *
 * Under reduced motion nothing may jump, so it holds three dots: the ellipsis
 * is the clearest still glyph for "in progress".
 */

import { ACID } from "../art.ts";
import { LIMIT, NO_BODY, TIMING } from "../motion.ts";
import { CENTRE, box, dotAt, regular, roundedPolygonLoop, split, toSpline, whole } from "../shapes.ts";
import { CHANGE, NO_GESTURE, type Beat, type StateDefinition } from "./definition.ts";

/**
 * The beat. A change looks finished in about 200 ms, so this is a short hold
 * and then the next jump — a steady clock, never a drift, so it reads as
 * rhythm.
 */
const TICK = 640;
/**
 * How much harder a jump lands than an ordinary change, as a multiple of the
 * squash limit. The jumps are the whole point of the state.
 */
const LANDING = 1.6;

/** The three dots. Wide enough apart to read as three, close enough to read as one glyph. */
const DOTS = { y: 513, r: 84, spacing: 262 } as const;

/**
 * A jump: the same shape of beat as a change, landed harder. The stretch on
 * the beat and the squash after it are what make each new shape arrive *on*
 * the tick instead of simply appearing there. The head holds still through
 * it; turning it with every jump made the state busy rather than rhythmic.
 */
const JUMP: readonly Beat[] = [
  { at: 0, apply: (self) => void (self.squash.target = -LIMIT.bodySquash * LANDING) },
  { at: TIMING.morphSquash, apply: (self) => void (self.squash.target = LIMIT.bodySquash * LANDING * 0.6) },
  { at: TIMING.morphGlance, apply: (self) => void (self.squash.target = 0) },
];

export const loading: StateDefinition = {
  // The still frame. The face rides the middle dot: small, because the dot is,
  // and set a little low so the band crosses the dot where it is wide.
  silhouette: {
    loops: split([
      dotAt(CENTRE.x - DOTS.spacing, DOTS.y, DOTS.r),
      dotAt(CENTRE.x, DOTS.y, DOTS.r),
      dotAt(CENTRE.x + DOTS.spacing, DOTS.y, DOTS.r),
    ]),
    face: { x: 490, y: 524, spread: 23, scale: 0.25, knot: { x: 556, y: 496 }, tailScale: 0.27, rides: 1 },
  },
  cycle: {
    // Each shape wears the character at a size and place that suits it: the
    // triangle is narrow at the top, so its head sits low where it is wide;
    // the bar is the only shape with no corners to place the face against;
    // the play shape is widest down its left edge.
    frames: [
      {
        loops: whole(toSpline(roundedPolygonLoop(regular(3, 400, 0), 96))),
        face: { x: 490, y: 572, spread: 88, scale: 0.72, knot: { x: 688, y: 458 }, tailScale: 0.72, rides: 0 },
      },
      {
        loops: whole(toSpline(roundedPolygonLoop(box(300, 300), 96))),
        face: { x: 490, y: 556, spread: 98, scale: 0.84, knot: { x: 776, y: 460 }, tailScale: 0.88, rides: 0 },
      },
      {
        loops: whole(toSpline(roundedPolygonLoop(box(176, 320), 176))),
        face: { x: 490, y: 476, spread: 62, scale: 0.52, knot: { x: 664, y: 344 }, tailScale: 0.56, rides: 0 },
      },
      {
        loops: whole(toSpline(roundedPolygonLoop(regular(3, 400, 90), 96))),
        face: { x: 486, y: 508, spread: 76, scale: 0.68, knot: { x: 648, y: 384 }, tailScale: 0.62, rides: 0 },
      },
    ],
    tick: TICK,
    beat: JUMP,
  },
  expression: {
    // The scowl at ease: a little less drop, eyes open, a calm look a touch
    // downward. The shapes carry the state; the face just waits.
    brow: { innerDrop: 36, lift: 0, bow: 2 },
    browSkew: 0,
    eyeOpen: 1,
    gaze: { x: 0, y: 0.12 },
    turn: 0,
    body: NO_BODY,
  },
  band: ACID,
  // No breath and no sway: the shape is changing every tick, and that is the life.
  life: { period: 1.4, breathe: 0, sway: 0, hemDrift: 0, gazeWander: 0.05 },
  bandSpin: 0,
  entry: CHANGE,
  gesture: () => NO_GESTURE,
};
