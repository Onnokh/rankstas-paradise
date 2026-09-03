/**
 * The motion grammar of the rig: how far anything may travel, how long the
 * shared beats last, how the springs behave, and what an expression and a
 * breath are made of.
 *
 * Everything here belongs to the character, not to any one state. What each
 * state does with it lives in `states/`.
 */

import type { BrowShape } from "./geometry.ts";

/** Bounds, in viewBox units on a 1024 canvas. Nothing may travel further. */
export const LIMIT = {
  /** Eye travel inside the visor. */
  gazeX: 26,
  gazeY: 14,
  /** How much of the gaze the brows take. Brows drift, they do not track. */
  browFollow: 0.3,
  /** Horizontal body lean. About 2 % of the canvas. */
  bodyLean: 20,
  /** Body squash and stretch. 1 % to 2 %, no more. */
  bodySquash: 0.02,
  /** Tail bend away from rest, in degrees at the tip. */
  tailDegrees: 9,
  /** How far the hem may trail the body, and how far it may ripple. */
  hemTrail: 26,
  hemRipple: 22,
  /** How much of a jump the hem's ripple springs chase, in squash units per viewBox unit of lift. */
  liftRipple: 0.0003,
} as const;

/** Beat lengths, in milliseconds. */
export const TIMING = {
  /** The eye is shut for barely longer than a frame or two. */
  blinkClose: 95,
  /** An irregular blink. The eyes spend nearly all their time open. */
  blinkGapMin: 4000,
  blinkGapMax: 9000,
  /**
   * A morph has no wind-up.
   *
   * The reference goes straight for the new shape — no settle back, no
   * anticipation, no travel. The only overlay is a short squash through the
   * change, and a glance that decays out of it.
   */
  morphSquash: 190,
  morphGlance: 320,
} as const;

/** How the silhouette twists through a change. */
export const MORPH_TWIST = {
  /**
   * How far round the outline the target's points are offset, as a fraction of
   * the point count.
   *
   * Zero gives a symmetric morph where every point takes the shortest route,
   * which reads as a crossfade. A small offset makes the outline travel round
   * itself and the intermediates come out lopsided, which is what the
   * reference does.
   */
  offset: 0.08,
  /**
   * A loop that is not changing shape gets no twist, or a body that stays the
   * ghost would swirl round itself for no reason. This is how far apart two
   * loops may be and still count as the same shape, in viewBox units.
   */
  sameWithin: 2,
} as const;

/** Spring constants. Higher stiffness arrives sooner; damping stops the overshoot. */
export const SPRING = {
  /** Arrives in about 230 ms. */
  gaze: { stiffness: 300, damping: 34 },
  /**
   * Stiff enough that a 110 ms shake offset actually travels. A slower body
   * spring turns every short beat into an invisible twitch.
   */
  body: { stiffness: 420, damping: 41 },
  /**
   * The shape of an expression. Slower than the body — a face settles, it does
   * not snap — but fast enough to land inside the morph.
   */
  expression: { stiffness: 260, damping: 31 },
  /** A blink has to be crisp, so it is the stiffest thing in the rig. */
  lid: { stiffness: 1500, damping: 72 },
  /** Softer and slightly underdamped: the tails arrive after the body, swing once, and stop. */
  tail: { stiffness: 160, damping: 22 },
  /**
   * The silhouette change.
   *
   * Measured off the reference: a bar opening into a circle reaches 99 % in
   * 420 ms with no overshoot at all, and a hexagon settling into a triangle
   * looks finished in 200 ms. Both fit one critically damped spring at about
   * omega 15.7 — the small change simply hides its own tail.
   */
  morph: { stiffness: 250, damping: 32 },
  /**
   * The band colour.
   *
   * Stiff on purpose — about 130 ms. A colour that arrives slowly spends the
   * whole change somewhere between the two, and a band that is half acid and
   * half amber says nothing at all.
   */
  tint: { stiffness: 900, damping: 60 },
  /** The head turn. Quick enough that a 110 ms shake beat actually travels. */
  turn: { stiffness: 380, damping: 39 },
} as const;

/**
 * One spring per hem node, from the left corner to the right corner.
 *
 * The corners are pinned to the body sides, so they follow it almost exactly.
 * The centre dip hangs free, so it is soft and slightly underdamped: it arrives
 * late, overshoots once, and stops. Rendering each node's *distance behind the
 * body* is what turns a rigid shift into cloth.
 */
export const HEM_SPRING = [
  { stiffness: 560, damping: 47 },
  { stiffness: 320, damping: 32 },
  { stiffness: 210, damping: 24 },
  { stiffness: 320, damping: 32 },
  { stiffness: 560, damping: 47 },
] as const;

/** How strongly the hem lag reads. Multiplies the distance a node sits behind the body. */
export const HEM_GAIN = { trail: 1.6, ripple: 1100 } as const;

/**
 * How far each silhouette parameter travels at full strength.
 *
 * These are deliberately small. The character has to stay the character: the
 * silhouette carries a mood, it does not become a different symbol.
 */
export const SILHOUETTE_GAIN = {
  /**
   * Full height change, as a fraction. The ceiling on this is the tile: the
   * artwork leaves about 144 units of headroom, and height plus peak together
   * must not spend all of it.
   */
  height: 0.14,
  /** Full width change, as a fraction. */
  width: 0.16,
  /** How much of a width change reaches the crown. The rest lands at the feet. */
  widthBase: 0.45,
  /** How far the crown rises when it is drawn to a point, in viewBox units. */
  peakRise: 50,
  /** How far the crown narrows when it is drawn to a point, as a fraction. */
  peakNarrow: 0.3,
  /** How completely the hem waves collapse at hem = -1. */
  hemFlatten: 1,
  /** How much further they dig at hem = +1. */
  hemDeepen: 0.8,
} as const;

/** What the ghost's field holds in one state. Each value runs -1 to 1. */
export interface BodyShape {
  readonly height: number;
  readonly width: number;
  readonly hem: number;
  readonly peak: number;
  /** How far the crown bends to one side, in viewBox units. */
  readonly tilt: number;
}

/**
 * Everything that makes one expression. Any two of these blend.
 *
 * One face, five moods: the brand face is the scowl — a steep inner drop on
 * both brows, round eyes — and every state keeps that family, saying its mood
 * with small deltas from it. A state that swapped in a different face would
 * stop being the character.
 */
export interface Expression {
  readonly brow: BrowShape;
  /** One brow up, the other down, in viewBox units. Positive raises the left brow. */
  readonly browSkew: number;
  /** 1 is a round open eye. Below 1 squints, above 1 widens. */
  readonly eyeOpen: number;
  /** Where the state rests its gaze when the application aims nothing. */
  readonly gaze: { readonly x: number; readonly y: number };
  /** The head turn the state holds, -1 to 1. */
  readonly turn: number;
  /**
   * The field the state holds over its silhouette.
   *
   * Only a ghost-bodied state should use it. The field is shaped for the
   * ghost — its hem, its crown — and on any other shape it pulls at the wrong
   * places.
   */
  readonly body: BodyShape;
}

/** The field left alone: the silhouette as its shape defines it. */
export const NO_BODY: BodyShape = { height: 0, width: 0, hem: 0, peak: 0, tilt: 0 };

/**
 * How far a turn goes.
 *
 * The model itself is in `head.ts`: the head is a sphere and a yaw re-projects
 * every point on it, so nothing slides and the mascot never rotates in the
 * plane. These are the bounds that model is driven within.
 */
export const TURN = {
  /** Degrees of yaw at a full turn of 1. */
  degrees: 45,
  /**
   * A little perspective on top of the projection: what comes toward you grows
   * by this fraction at full depth, what goes away shrinks. Orthographic
   * projection alone reads flat.
   */
  perspective: 0.14,
  /** How far a change glances aside. Small: the reference barely turns through one. */
  glance: 0.15,
  /**
   * How much of the yaw the hem takes. The skirt is a cylinder and its scallop
   * pattern runs round it, so a turn reads the pattern from a new angle: new
   * scallops come into view on one side as others go round the other. Less
   * than the head's full yaw, because the skirt hangs looser than the head.
   */
  hemShare: 0.7,
} as const;

/**
 * The ambient signature of each state.
 *
 * A held state is not a still frame. Each one breathes at its own rate and
 * with its own weight, so the mascot reads as alive and as *this* state even
 * when nothing is happening. Amplitudes are small on purpose: this is a pulse,
 * not a bob.
 *
 * The period is also the clock for the state's gesture, so the two never fall
 * out of step.
 *
 * All of it stops under reduced motion and while the document is hidden.
 */
export interface Life {
  /** Seconds per cycle. */
  readonly period: number;
  /** Breathing depth, in silhouette-parameter units. */
  readonly breathe: number;
  /** Side-to-side drift, in viewBox units. */
  readonly sway: number;
  /** How much the free hem stirs, in viewBox units. Only the ghost has a hem. */
  readonly hemDrift: number;
  /** How far the eyes wander when the application is not aiming them, 0 to 1. */
  readonly gazeWander: number;
}

/**
 * The second frequency each ambient channel runs at, relative to the breath.
 *
 * None of these divide evenly into 1, so the channels never line up twice the
 * same way and the loop cannot be heard.
 */
export const LIFE_RATIO = { sway: 0.61, hem: 0.83, gaze: 0.37, gazeCross: 0.23 } as const;

/** A critically damped spring, stepped by the render loop. */
export class Spring {
  value: number;
  target: number;
  private velocity = 0;

  constructor(
    private readonly stiffness: number,
    private readonly damping: number,
    initial = 0,
  ) {
    this.value = initial;
    this.target = initial;
  }

  /** @param dt Seconds since the last step. */
  step(dt: number): void {
    const acceleration =
      -this.stiffness * (this.value - this.target) - this.damping * this.velocity;
    this.velocity += acceleration * dt;
    this.value += this.velocity * dt;
  }

  /** Jump to the target with no travel. Used when motion is suppressed. */
  settle(): void {
    this.value = this.target;
    this.velocity = 0;
  }

  /** True once the spring has arrived and stopped. */
  get atRest(): boolean {
    return Math.abs(this.value - this.target) < 0.0005 && Math.abs(this.velocity) < 0.0005;
  }
}

export function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

export function randomBetween(low: number, high: number): number {
  return low + Math.random() * (high - low);
}
