/**
 * What a state is.
 *
 * Every state is one `StateDefinition`: the silhouette it holds and where the
 * character sits on it, the face it wears, the band colour, its breath, the
 * beats that overlay its arrival, and the gesture it makes while held. The
 * runtime reads these and nothing else — it has no idea which state is which,
 * so adding a state means adding a file here and a line in `index.ts`.
 *
 * Two of the fields are optional in effect: `cycle` for a state whose shape
 * changes on a clock, and `bandSpin` for a state whose headband turns.
 */

import type { Point } from "../geometry.ts";
import { LIMIT, TIMING, TURN, type Expression, type Life, type Spring } from "../motion.ts";
import { PARTS, type Silhouette } from "../shapes.ts";

/** How one loop of the silhouette moves within the gesture. */
export interface LoopMotion {
  readonly shift: Point;
  /** Scale about the loop's own centre. */
  readonly scale: number;
}

/**
 * The motion a held state makes, read off its clock every frame.
 *
 * Everything here is added to what is drawn, never to a spring target: a
 * target the springs chase would lag and smear the motion. A gesture is
 * weighted by the morph, so it fades in as the shape arrives.
 */
export interface Gesture {
  /** One entry per loop of the silhouette. */
  readonly loops: readonly LoopMotion[];
  /** A yaw, -1 to 1, added to the turn the state holds. */
  readonly turn: number;
  /** Added to the crown's peak, -1 to 1. Only the ghost has a crown. */
  readonly peak: number;
  /** Added to the crown's tilt, in viewBox units. */
  readonly tilt: number;
  /** Added to the gaze, -1 to 1 on each axis, when nothing is aiming the eyes. */
  readonly gaze: Point;
  /** How open the winking eye is, 0 to 1. 1 is not winking. */
  readonly wink: number;
  /** How far the whole character is off the floor, in viewBox units. */
  readonly lift: number;
  /** Squash added to the body, in squash units: positive presses, negative stretches. */
  readonly squash: number;
}

const STILL: LoopMotion = { shift: { x: 0, y: 0 }, scale: 1 };

/** Every loop where it is. */
const HELD: readonly LoopMotion[] = Array.from({ length: PARTS }, () => STILL);

/** No gesture at all: a state with nothing to add, reduced motion, or a hidden document. */
export const NO_GESTURE: Gesture = {
  loops: HELD,
  turn: 0,
  peak: 0,
  tilt: 0,
  gaze: { x: 0, y: 0 },
  wink: 1,
  lift: 0,
  squash: 0,
};

/**
 * The part of the runtime a beat may reach.
 *
 * Beats set spring targets and call the few moves that need the runtime's
 * knowledge — where the turn should come home to, which way this change is
 * swinging. Nothing else of the runtime is theirs.
 */
export interface Performer {
  /** Body squash and stretch, in squash units. */
  readonly squash: Spring;
  /** Horizontal body lean, in viewBox units. */
  readonly lean: Spring;
  /**
   * The head turn, -1 to 1. Read it to build a glance off where the head is,
   * but write it through `turnTo`, or the glance takes a head the application
   * holds off the yaw it asked for. `homeTurn` brings the head back.
   */
  readonly turn: Spring;
  /** The eyelids, 1 open. Shared by both eyes; the blink is the one beat that uses it. */
  readonly lid: Spring;
  /** Which way the current change swings, 1 or -1. Flips every change. */
  readonly direction: number;
  /** Turn the head to a state's own target. An application's `turnHead` wins over it. */
  turnTo(turn: number): void;
  /** Back to the turn in force: the application's, or the state's. */
  homeTurn(): void;
}

/** One timed change of spring targets, `at` milliseconds after the arrival. */
export interface Beat {
  readonly at: number;
  readonly apply: (self: Performer) => void;
}

/** A state whose shape changes on a clock. */
export interface Cycle {
  /** The shapes in order. The state enters on the first and steps through the rest. */
  readonly frames: readonly Silhouette[];
  /** Milliseconds between steps. */
  readonly tick: number;
  /** The beats that overlay each step. */
  readonly beat: readonly Beat[];
}

export interface StateDefinition {
  /**
   * The shape the state holds, and where the character sits on it. For a
   * cycling state this is the still frame: what it shows when nothing may
   * move.
   */
  readonly silhouette: Silhouette;
  readonly cycle?: Cycle;
  readonly expression: Expression;
  /** The headband colour. Acid is rest; a different colour is a claim. */
  readonly band: string;
  readonly life: Life;
  /** How fast the headband turns round the head while held, in radians per second. */
  readonly bandSpin: number;
  /** The beats that overlay the arrival. */
  readonly entry: readonly Beat[];
  /**
   * The motion in the shape while held.
   *
   * @param phase The state's clock, in radians; one cycle of `life.period` is 2π.
   * @param weight 0 while the silhouette is still arriving, 1 once it has.
   */
  readonly gesture: (phase: number, weight: number) => Gesture;
}

// ------------------------------------------------------------------ shared

/**
 * What overlays every change.
 *
 * Almost nothing, and that is the point. Measured off the reference: through a
 * shape change its centroid moves under one percent of the frame, there is no
 * wind-up, and there is no travel. The shape simply springs to the new one in
 * about 200 ms.
 *
 * So this carries a short squash through the change — the way any volume
 * changing shape would — and a glance that decays out of it. Nothing else.
 */
export const CHANGE: readonly Beat[] = [
  {
    at: 0,
    apply: (self) => {
      self.squash.target = -LIMIT.bodySquash * 0.8;
      // Through `turnTo`, not the spring, so a head the application holds
      // stays where it was put. A glance that wrote the target itself would
      // pull the head off the yaw the application asked for, and the two
      // would disagree until the glance decayed.
      self.turnTo(self.turn.target + TURN.glance * self.direction);
    },
  },
  { at: TIMING.morphSquash, apply: (self) => void (self.squash.target = LIMIT.bodySquash * 0.4) },
  {
    at: TIMING.morphGlance,
    apply: (self) => {
      self.squash.target = 0;
      self.homeTurn();
    },
  },
];

/**
 * The slow look-around. Two sines at frequencies that divide into neither the
 * breath nor each other, so the head drifts the way attention does — never the
 * same swing twice, never a metronome. Both are far slower than the breath.
 */
export function look(phase: number): number {
  return 0.65 * Math.sin(phase * 0.31 + 1.1) + 0.35 * Math.sin(phase * 0.19 + 2.4);
}

/** The positive half of a wave: a lift, a beat, a window. */
export function rise(value: number): number {
  return Math.max(0, value);
}

/** A loop motion at a given weight. */
export function move(shift: Point, scale: number, weight: number): LoopMotion {
  return {
    shift: { x: shift.x * weight, y: shift.y * weight },
    scale: 1 + (scale - 1) * weight,
  };
}
