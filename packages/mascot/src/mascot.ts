/**
 * The Ranksta mascot controller.
 *
 * Nothing in the rig is a stored pose. A state is a silhouette, a face layout,
 * and a set of shape parameters; springs carry the change, and every frame
 * re-emits the geometry from wherever the springs currently sit. Two states
 * therefore have an unbroken run of real shapes between them.
 *
 * A held state is not a still frame. Each one breathes at its own rate and
 * makes its own gesture in its own shape, so the loop runs for as long as the
 * mascot is visible and motion is allowed.
 *
 * The runtime does not know one state from another. Everything a state is —
 * its shape, face, colour, breath, arrival, and gesture — is a `StateDefinition`
 * in `states/`, and the runtime only ever reads the definition of the state in
 * force.
 */

import {
  ACID,
  ANCHOR,
  BAND_REST,
  BAND_SHADOW_REST,
  BODY_REST,
  TAIL_BOTTOM_REST,
  TAIL_TOP_REST,
  VISOR_REST,
  rigMarkup,
  readParts,
  type RigParts,
} from "./art.ts";
import { characterField, isRest, localScale, type Deformation } from "./deform.ts";
import {
  bendAround,
  browShape,
  ellipseShape,
  emitPath,
  lerpPath,
  mapPath,
  mixRgb,
  parseHex,
  rgbCss,
  rotateSpline,
  parsePath,
  type Point,
  type Rgb,
  type Segment,
} from "./geometry.ts";
import {
  bandMaskLoop,
  blendFace,
  compose,
  faceMap,
  ghostLoopsOf,
  knotMap,
  moveLoop,
  perLoop,
  rideFace,
  sameLoop,
  translateLoop,
  twinsOf,
  type GhostLoop,
} from "./loops.ts";
import {
  KNOT_ON_STRIP,
  angleOf,
  bandRing,
  depthOf,
  project,
  ringAt,
  wrapAngle,
  yawWarp,
} from "./head.ts";
import {
  HEM_GAIN,
  HEM_SPRING,
  LIFE_RATIO,
  LIMIT,
  MORPH_TWIST,
  SPRING,
  Spring,
  TIMING,
  TURN,
  clamp,
  randomBetween,
} from "./motion.ts";
import { ghostSpline, POINTS, type FaceLayout, type Silhouette } from "./shapes.ts";
import {
  CHANGE,
  NO_GESTURE,
  STATE,
  type Beat,
  type Gesture,
  type LoopMotion,
  type Performer,
  type StateDefinition,
} from "./states/index.ts";
import { ensureStylesheet } from "./styles.ts";
import type { Gaze, Mascot, MascotOptions, MascotState } from "./types.ts";

/** The rest geometry, parsed once for every mascot on the page. */
const REST = {
  body: parsePath(BODY_REST),
  band: parsePath(BAND_REST),
  bandShadow: parsePath(BAND_SHADOW_REST),
  visor: parsePath(VISOR_REST),
  tailTop: TAIL_TOP_REST.map(parsePath) as readonly (readonly Segment[])[],
  tailBottom: TAIL_BOTTOM_REST.map(parsePath) as readonly (readonly Segment[])[],
} as const;

/**
 * The same shapes re-emitted, so a resting character is the artwork itself.
 *
 * Emitted at the rig's own precision, which rounds to two decimals where the
 * artwork carries three. Every resting path in the rig is built this way, so
 * they all agree.
 */
const AT_REST = {
  body: emitPath(REST.body),
  band: emitPath(REST.band),
  bandShadow: emitPath(REST.bandShadow),
  visor: emitPath(REST.visor),
} as const;

interface Sequence {
  readonly beats: readonly Beat[];
  readonly startedAt: number;
  next: number;
}

/** The side of the canvas, in viewBox units. Every anchor in `art.ts` is on it. */
const CANVAS = 1024;

const IDENTITY = (point: Point): Point => point;

/** No ambient signal at all: reduced motion, or a hidden document. */
const STILL = {
  breathe: 0,
  narrow: 0,
  sway: 0,
  stir: (): number => 0,
  gaze: { x: 0, y: 0 },
} as const;

let instanceCount = 0;

class Runtime implements Mascot, Performer {
  readonly element: SVGSVGElement;

  private readonly parts: RigParts;
  private readonly reducedMotionQuery: MediaQueryList;
  private readonly document: Document;
  private readonly view: Window;

  private current: MascotState;
  private reducedMotionOverride: boolean | null;

  // Only the springs a beat may reach are public; `Performer` in
  // `states/definition.ts` is the whole of that contract. Everything else the
  // rig carries belongs to the rig.
  readonly lean = new Spring(SPRING.body.stiffness, SPRING.body.damping);
  /** The head turn. Everything reads it: face, eyes, silhouette, tails. */
  readonly turn = new Spring(SPRING.turn.stiffness, SPRING.turn.damping);
  readonly squash = new Spring(SPRING.body.stiffness, SPRING.body.damping);

  private readonly gazeX = new Spring(SPRING.gaze.stiffness, SPRING.gaze.damping);
  private readonly gazeY = new Spring(SPRING.gaze.stiffness, SPRING.gaze.damping);
  /** How far the whole character is off the floor. A jump. */
  private readonly lift = new Spring(SPRING.body.stiffness, SPRING.body.damping);
  /**
   * How far the band has turned round the head, in radians. Accumulates while
   * thinking; comes home to a whole number of turns when thinking ends.
   */
  private readonly spin = new Spring(SPRING.turn.stiffness, SPRING.turn.damping);
  /** The right eye's own lid, for the wink. 1 is open. */
  private readonly wink = new Spring(SPRING.lid.stiffness, SPRING.lid.damping, 1);

  private readonly browInnerDrop: Spring;
  private readonly browLift: Spring;
  private readonly browBow: Spring;
  private readonly browSkew: Spring;
  private readonly eyeShape: Spring;
  private readonly bodyHeight: Spring;
  private readonly bodyWidth: Spring;
  private readonly bodyHem: Spring;
  private readonly bodyPeak: Spring;
  private readonly bodyTilt: Spring;
  /** Separate from `eyeShape`, so a blink can cut across any expression. */
  readonly lid = new Spring(SPRING.lid.stiffness, SPRING.lid.damping, 1);
  /** 0 while the silhouette is leaving one shape, 1 once it has arrived at the next. */
  private readonly morph = new Spring(SPRING.morph.stiffness, SPRING.morph.damping, 1);
  /** 0 while the band is leaving one colour, 1 once it has arrived at the next. */
  private readonly bandBlend = new Spring(SPRING.tint.stiffness, SPRING.tint.damping, 1);
  private readonly tailTopBend = new Spring(SPRING.tail.stiffness, SPRING.tail.damping);
  private readonly tailBottomBend = new Spring(SPRING.tail.stiffness, SPRING.tail.damping);
  private readonly hemTrail: readonly Spring[];
  private readonly hemRipple: readonly Spring[];
  private readonly allSprings: readonly Spring[];

  private bandFrom: Rgb = parseHex(ACID);
  private bandTo: Rgb = parseHex(ACID);
  private bandTarget: string = ACID;
  private drawnBand: Rgb = parseHex(ACID);
  /** Flipped every change, so the character does not always swing the same way. */
  private swing = 1;
  /** The silhouette is always PARTS loops; a single shape is PARTS identical copies. */
  private morphFrom: readonly (readonly Segment[])[];
  private morphTo: readonly (readonly Segment[])[];
  private faceFrom: FaceLayout;
  private faceTo: FaceLayout;
  private drawnFace: FaceLayout;
  /** The silhouette drawn last frame, before the field. A new change departs from it. */
  private drawnSpline: readonly (readonly Segment[])[];
  /** The state's clock. Accumulated, so changing state never jumps the phase. */
  private phase = 0;
  private gazeOverride: Gaze | null = null;
  private turnOverride: number | null = null;
  /** True while the tails are drawn behind the body. */
  private tailsBehind = false;
  /**
   * For each target loop that is the ghost: where it sits and how it is
   * twisted, so the ghost with its hem turned can stand in for it each frame.
   * Only the ghost has a hem to turn.
   */
  private ghostLoops: readonly (GhostLoop | null)[];
  /** The beats that overlay the arrival in the current state. */
  private entrySeq: Sequence | null = null;
  /** The state's gesture for this frame, read once per tick so the hem can chase it too. */
  private motion: Gesture = NO_GESTURE;
  private blinkSeq: Sequence | null = null;
  private frame = 0;
  private lastFrameAt = 0;
  private blinkTimer = 0;
  /** A cycling state's clock, and which of its frames is on screen. */
  private cycleTimer = 0;
  private cycleFrame = 0;
  private destroyed = false;

  constructor(host: HTMLElement, options: MascotOptions) {
    this.document = host.ownerDocument;
    this.view = this.document.defaultView!;
    this.current = options.state ?? "idle";
    this.reducedMotionOverride = options.reducedMotion ?? null;
    this.reducedMotionQuery = this.view.matchMedia("(prefers-reduced-motion: reduce)");

    const definition = STATE[this.current];
    const start =
      definition.cycle !== undefined && !this.startsStill(options) ? definition.cycle.frames[0]! : definition.silhouette;
    this.morphFrom = start.loops;
    this.morphTo = start.loops;
    this.drawnSpline = start.loops;
    this.faceFrom = start.face;
    this.faceTo = start.face;
    this.drawnFace = start.face;
    // A mascot built straight into a state never goes through a change, so the
    // ghost bookkeeping has to be read off the starting shape here too.
    this.ghostLoops = ghostLoopsOf(start.loops, start.loops.map(() => 0));

    const rest = definition.expression;
    const { stiffness, damping } = SPRING.expression;
    this.browInnerDrop = new Spring(stiffness, damping, rest.brow.innerDrop);
    this.browLift = new Spring(stiffness, damping, rest.brow.lift);
    this.browBow = new Spring(stiffness, damping, rest.brow.bow);
    this.browSkew = new Spring(stiffness, damping, rest.browSkew);
    this.eyeShape = new Spring(stiffness, damping, rest.eyeOpen);
    this.bodyHeight = new Spring(stiffness, damping, rest.body.height);
    this.bodyWidth = new Spring(stiffness, damping, rest.body.width);
    this.bodyHem = new Spring(stiffness, damping, rest.body.hem);
    this.bodyPeak = new Spring(stiffness, damping, rest.body.peak);
    this.bodyTilt = new Spring(stiffness, damping, rest.body.tilt);
    this.turn.value = this.turn.target = rest.turn;
    this.hemTrail = HEM_SPRING.map((s) => new Spring(s.stiffness, s.damping));
    this.hemRipple = HEM_SPRING.map((s) => new Spring(s.stiffness, s.damping));
    this.allSprings = [
      this.gazeX, this.gazeY, this.lean, this.squash, this.lift, this.spin, this.wink, this.turn,
      this.browInnerDrop, this.browLift, this.browBow, this.browSkew, this.eyeShape, this.lid,
      this.bodyHeight, this.bodyWidth, this.bodyHem, this.bodyPeak, this.bodyTilt,
      this.morph, this.bandBlend,
      this.tailTopBend, this.tailBottomBend,
      ...this.hemTrail, ...this.hemRipple,
    ];

    ensureStylesheet(this.document);

    const id = `rk${++instanceCount}`;
    const svg = this.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${CANVAS} ${CANVAS}`);
    svg.setAttribute("class", "rk-root");
    if (options.label === null || options.label === undefined) {
      svg.setAttribute("aria-hidden", "true");
    } else {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", options.label);
    }
    svg.innerHTML = rigMarkup(id, { tile: options.tile ?? false });
    host.append(svg);

    this.element = svg;
    this.parts = readParts(svg, id);
    svg.dataset.state = this.current;
    svg.dataset.reducedMotion = String(this.reducedMotion);

    this.reducedMotionQuery.addEventListener("change", this.onMotionContextChange);
    this.document.addEventListener("visibilitychange", this.onMotionContextChange);

    this.applyExpression();
    this.draw();
    // A held state is not a still frame, so the loop starts here. Waiting for
    // the first blink to wake it left a new mascot completely still for up to
    // nine seconds.
    //
    // When motion is suppressed this settles every spring and draws again
    // instead, which is the only chance those springs get: nothing else runs.
    // Without it a mascot built straight into a state shows what it was
    // leaving rather than what it is — `error` keeping the acid band it
    // started from, which is the one state that says something in colour.
    this.wake();
    this.scheduleBlink();
    this.scheduleCycle();
  }

  /** Whether a mascot constructed in a cycling state should show its still frame. */
  private startsStill(options: MascotOptions): boolean {
    return (options.reducedMotion ?? this.reducedMotionQuery.matches) || this.document.hidden;
  }

  // ---------------------------------------------------------------- state

  get state(): MascotState {
    return this.current;
  }

  private get definition(): StateDefinition {
    return STATE[this.current];
  }

  /** Which way the current change swings. Read by the entry beats. */
  get direction(): number {
    return this.swing;
  }

  get reducedMotion(): boolean {
    if (this.reducedMotionOverride !== null) return this.reducedMotionOverride;
    return this.reducedMotionQuery.matches;
  }

  /** True when nothing may move: reduced motion, or the tab is in the background. */
  private get motionSuppressed(): boolean {
    return this.reducedMotion || this.document.hidden;
  }

  /**
   * Change state.
   *
   * The silhouette always departs from what is on screen, so going straight
   * from one state to another does not detour through the ghost. The new
   * state's gesture fades in as its shape arrives.
   */
  setState(next: MascotState): void {
    if (next === this.current) return;
    this.current = next;
    this.element.dataset.state = next;
    this.clearCycle();
    // A turning band comes home to the nearest whole turn, so it ends where it
    // started without a jump.
    this.spin.target = Math.round(this.spin.target / (Math.PI * 2)) * Math.PI * 2;

    // A cycling state enters on its first frame, and holds its still frame
    // when nothing may move.
    const { cycle, silhouette, entry } = this.definition;
    this.cycleFrame = 0;
    this.beginMorph(cycle !== undefined && !this.motionSuppressed ? cycle.frames[0]! : silhouette, entry);
    this.scheduleCycle();
  }

  /**
   * Become a silhouette.
   *
   * The change always departs from what is on screen, so any shape can follow
   * any other without a detour through the ghost. The new state's gesture
   * fades in as its shape arrives.
   */
  private beginMorph(target: Silhouette, entry: readonly Beat[]): void {
    this.swing = -this.swing;
    this.morphFrom = this.drawnSpline;
    // Offsetting where the target starts makes the outline travel round itself
    // through the change instead of every point taking the shortest route. A
    // loop that keeps its shape gets none of it, or it would swirl in place.
    const twist = Math.round(POINTS * MORPH_TWIST.offset) * this.swing;
    const twists = target.loops.map((loop, i) => (sameLoop(this.morphFrom[i]!, loop) ? 0 : twist));
    // Identical source loops share one rotated copy. There is only ever the one
    // `twist`, so the source is the whole key, and sharing the reference is what
    // lets `draw` recognise the copies of a whole shape and emit them once.
    const spun = new Map<readonly Segment[], readonly Segment[]>();
    this.morphTo = target.loops.map((loop, i) => {
      if (twists[i] === 0) return loop;
      const already = spun.get(loop);
      if (already !== undefined) return already;
      const rotated = rotateSpline(loop, twists[i]!);
      spun.set(loop, rotated);
      return rotated;
    });
    this.ghostLoops = ghostLoopsOf(target.loops, twists);
    this.faceFrom = this.drawnFace;
    this.faceTo = target.face;
    this.morph.value = 0;
    // Straight for the new shape. The reference has no anticipation and holds
    // nothing back.
    this.morph.target = 1;

    // Whatever beat the last arrival was still playing is over.
    this.entrySeq = null;
    this.lean.target = 0;
    this.squash.target = 0;
    this.lift.target = 0;
    this.wink.target = 1;
    this.applyExpression();

    if (!this.motionSuppressed) {
      this.entrySeq = { beats: entry, startedAt: this.view.performance.now(), next: 0 };
    }
    this.wake();
  }

  /** Every tick, a cycling state becomes the next shape in its cycle. */
  private scheduleCycle(): void {
    const { cycle } = this.definition;
    if (cycle === undefined || this.motionSuppressed) return;
    this.cycleTimer = this.view.setTimeout(() => {
      this.cycleTimer = 0;
      if (this.definition.cycle !== cycle || this.motionSuppressed) return;
      this.cycleFrame = (this.cycleFrame + 1) % cycle.frames.length;
      this.beginMorph(cycle.frames[this.cycleFrame]!, cycle.beat);
      this.scheduleCycle();
    }, cycle.tick);
  }

  private clearCycle(): void {
    if (this.cycleTimer !== 0) this.view.clearTimeout(this.cycleTimer);
    this.cycleTimer = 0;
  }

  private get expression() {
    return this.definition.expression;
  }

  private applyExpression(): void {
    const { brow, browSkew, eyeOpen, body, turn } = this.expression;
    this.browInnerDrop.target = brow.innerDrop;
    this.browLift.target = brow.lift;
    this.browBow.target = brow.bow;
    this.browSkew.target = browSkew;
    this.eyeShape.target = eyeOpen;
    this.bodyHeight.target = body.height;
    this.bodyWidth.target = body.width;
    this.bodyHem.target = body.hem;
    this.bodyPeak.target = body.peak;
    this.bodyTilt.target = body.tilt;
    this.turn.target = this.turnOverride ?? turn;

    // The band takes its colour whole. Half a colour says nothing.
    const colour = this.definition.band;
    if (colour !== this.bandTarget) {
      this.bandTarget = colour;
      this.bandFrom = this.drawnBand;
      this.bandTo = parseHex(colour);
      this.bandBlend.value = 0;
      this.bandBlend.target = 1;
    }
    this.aimGaze();
  }

  /** The glance of a change, back to the turn in force. */
  homeTurn(): void {
    this.turn.target = this.turnOverride ?? this.expression.turn;
  }

  /** A state's own turn. An application's `turnHead` wins over it. */
  turnTo(turn: number): void {
    if (this.turnOverride !== null) return;
    this.turn.target = clamp(turn, -1, 1);
  }

  turnHead(yaw: number): void {
    this.turnOverride = clamp(yaw, -1, 1);
    this.homeTurn();
    this.wake();
  }

  releaseTurn(): void {
    this.turnOverride = null;
    this.homeTurn();
    this.wake();
  }

  // ---------------------------------------------------------------- gaze

  lookAt(gaze: Gaze): void {
    this.gazeOverride = { x: clamp(gaze.x, -1, 1), y: clamp(gaze.y, -1, 1) };
    this.aimGaze();
    this.wake();
  }

  /**
   * Aim the gaze at a point in the viewport.
   *
   * The eyes are measured from the face that is on screen, not from a fraction
   * of the box. `drawnFace` is in viewBox units on the canvas, and the canvas
   * fills the element, so dividing by the canvas and multiplying by the box
   * carries the face into client coordinates. Every shape wears the head
   * somewhere else — the exclamation mark's face sits far higher and the
   * loading dots' far smaller — so a fixed fraction aimed all of them from the
   * ghost's eyes.
   *
   * The span is nine tenths of the element, so the gaze reaches its bound near
   * the edge of the mascot rather than at the far side of the page. `lookAt`
   * clamps whatever comes out, so a distant point is a full look and no more.
   */
  lookAtPoint(clientX: number, clientY: number): void {
    const box = this.element.getBoundingClientRect();
    // An element with no box has no face to measure from, and no pixels to show
    // the result in.
    if (box.width === 0 || box.height === 0) return;
    const faceX = box.left + (this.drawnFace.x / CANVAS) * box.width;
    const faceY = box.top + (this.drawnFace.y / CANVAS) * box.height;
    this.lookAt({
      x: (clientX - faceX) / (box.width * 0.9),
      y: (clientY - faceY) / (box.height * 0.9),
    });
  }

  releaseGaze(): void {
    this.gazeOverride = null;
    this.aimGaze();
    this.wake();
  }

  private aimGaze(): void {
    // Reduced motion allows a static shape change, not gaze following. The
    // eyes hold the rest gaze of the expression and ignore any aim.
    const aim = this.motionSuppressed
      ? this.expression.gaze
      : (this.gazeOverride ?? this.expression.gaze);
    this.gazeX.target = clamp(aim.x, -1, 1) * LIMIT.gazeX;
    this.gazeY.target = clamp(aim.y, -1, 1) * LIMIT.gazeY;
  }

  // ---------------------------------------------------------------- blink

  blink(): void {
    if (this.motionSuppressed) return;
    this.blinkSeq = { beats: BLINK, startedAt: this.view.performance.now(), next: 0 };
    this.wake();
  }

  private scheduleBlink(): void {
    if (this.motionSuppressed) return;
    this.blinkTimer = this.view.setTimeout(() => {
      this.blink();
      this.scheduleBlink();
    }, randomBetween(TIMING.blinkGapMin, TIMING.blinkGapMax));
  }

  private clearBlink(): void {
    if (this.blinkTimer !== 0) this.view.clearTimeout(this.blinkTimer);
    this.blinkTimer = 0;
  }

  private stepSequence(sequence: Sequence | null, now: number): Sequence | null {
    if (sequence === null) return null;
    const elapsed = now - sequence.startedAt;
    while (sequence.next < sequence.beats.length && sequence.beats[sequence.next]!.at <= elapsed) {
      sequence.beats[sequence.next]!.apply(this);
      sequence.next += 1;
    }
    return sequence.next >= sequence.beats.length ? null : sequence;
  }

  // ------------------------------------------------------------ rendering

  private wake(): void {
    if (this.destroyed) return;
    if (this.motionSuppressed) {
      this.lid.target = 1;
      for (const spring of this.allSprings) spring.settle();
      this.draw();
      return;
    }
    if (this.frame !== 0) return;
    this.lastFrameAt = this.view.performance.now();
    this.frame = this.view.requestAnimationFrame(this.tick);
  }

  /**
   * The ambient signature of the state in force.
   *
   * Read every frame and added to the drawn values, never to the spring
   * targets: a target the springs chase would lag and smear the pulse.
   */
  private get life() {
    const signature = this.definition.life;
    const breathe = Math.sin(this.phase) * signature.breathe;
    return {
      breathe,
      // Breathing in narrows as it lengthens, the way a held breath does.
      narrow: -breathe * 0.45,
      sway: Math.sin(this.phase * LIFE_RATIO.sway + 1.1) * signature.sway,
      stir: (node: number): number =>
        Math.sin(this.phase * LIFE_RATIO.hem + node * 0.9) * signature.hemDrift,
      gaze: {
        x: Math.sin(this.phase * LIFE_RATIO.gaze + 0.4) * signature.gazeWander,
        y: Math.sin(this.phase * LIFE_RATIO.gazeCross + 2.1) * signature.gazeWander * 0.6,
      },
    };
  }

  private readonly tick = (now: number): void => {
    this.frame = 0;
    if (this.motionSuppressed) return;
    // A long frame gap (a background tab, a stalled main thread) must not
    // launch the springs; clamp the step to about two frames.
    const dt = clamp((now - this.lastFrameAt) / 1000, 0, 1 / 30);
    this.lastFrameAt = now;
    // Accumulated rather than read off the clock, so a state with a different
    // period picks up where the last one left off instead of jumping.
    const definition = this.definition;
    this.phase += (dt * Math.PI * 2) / definition.life.period;

    this.entrySeq = this.stepSequence(this.entrySeq, now);
    this.blinkSeq = this.stepSequence(this.blinkSeq, now);

    // A state that turns its band does so steadily. The spring follows the
    // target closely, so this is a constant speed, not a chase.
    if (definition.bandSpin !== 0) this.spin.target += dt * definition.bandSpin;

    // The state's gesture, fading in as its shape arrives. Nothing here goes
    // through a spring: it is read off the clock and drawn.
    this.motion = definition.gesture(this.phase, clamp(this.morph.value, 0, 1));

    // The tails chase the body, so they arrive a beat later and then stop.
    const swing = clamp(-this.lean.value / LIMIT.bodyLean, -1, 1) * LIMIT.tailDegrees;
    this.tailTopBend.target = swing;
    this.tailBottomBend.target = swing * 0.7;

    // Each hem node chases the body on its own spring. What gets drawn is how
    // far behind it has fallen, so the cloth trails and then catches up.
    for (const node of this.hemTrail) node.target = this.lean.value;
    // A jump lifts the body and the hem follows late, so the cloth trails the
    // jump and catches up on landing.
    for (const node of this.hemRipple) {
      node.target = this.squash.value + (this.lift.value + this.motion.lift) * LIMIT.liftRipple;
    }

    for (const spring of this.allSprings) spring.step(dt);
    this.draw();

    // A held state is not a still frame, so the loop does not shut down while
    // the mascot is visible. It stops the moment motion is suppressed.
    this.frame = this.view.requestAnimationFrame(this.tick);
  };

  private draw(): void {
    const life = this.motionSuppressed ? STILL : this.life;
    const lean = clamp(this.lean.value, -LIMIT.bodyLean, LIMIT.bodyLean);
    const morph = clamp(this.morph.value, 0, 1);
    const motion: Gesture = this.motionSuppressed ? NO_GESTURE : this.motion;
    const turn = clamp(this.turn.value + motion.turn, -1, 1);
    const yaw = (turn * TURN.degrees * Math.PI) / 180;
    // The sway is drawn, not sprung: the hem chases the *sprung* lean, so
    // feeding the ambient drift back into it would make the cloth chase itself.
    const lift = Math.max(0, this.lift.value + motion.lift);
    const shift = `translate(${(lean + life.sway).toFixed(2)}px, ${(-lift).toFixed(2)}px)`;
    this.parts.body.style.transform = shift;
    this.parts.tails.style.transform = shift;

    const deformation: Deformation = {
      height: this.bodyHeight.value + life.breathe,
      width: this.bodyWidth.value + life.narrow,
      hem: this.bodyHem.value,
      peak: clamp(this.bodyPeak.value + motion.peak, -1, 1),
      tilt: this.bodyTilt.value + motion.tilt,
      squash: clamp(this.squash.value + motion.squash * LIMIT.bodySquash, -LIMIT.bodySquash, LIMIT.bodySquash),
      // The ripple gain multiplies its spring by a thousand, so a spring that
      // has "arrived" can still be worth half a pixel. The rest check treats
      // anything under a hundredth of a pixel as still.
      trail: this.hemTrail.map(
        (node, i) =>
          clamp((node.value - this.lean.value) * HEM_GAIN.trail, -LIMIT.hemTrail, LIMIT.hemTrail) +
          life.stir(i),
      ),
      ripple: this.hemRipple.map((node) =>
        clamp(
          (node.value - this.squash.value - (this.lift.value + motion.lift) * LIMIT.liftRipple) *
            HEM_GAIN.ripple,
          -LIMIT.hemRipple,
          LIMIT.hemRipple,
        ),
      ),
    };

    const arrived = morph > 0.999;
    const spin = this.spin.value;
    const spinHome = Math.abs(spin - Math.round(spin / (Math.PI * 2)) * Math.PI * 2) < 0.001;
    // The fast path: the ghost, exactly where the artwork puts it, with
    // nothing moving. Then the artwork itself is emitted, byte for byte.
    const isArtwork = this.ghostLoops.every((g) => g !== null && g.dx === 0 && g.dy === 0);
    const resting =
      isArtwork && arrived && isRest(deformation) && Math.abs(turn) < 0.001 && spinHome && lift < 0.01;
    const field = resting ? IDENTITY : characterField(deformation);

    // A change departs from the silhouette on screen — gesture included, or the
    // dots would snap to the bottom of their wave the moment they leave — so
    // this has to be the loops even when the exact artwork is what gets
    // emitted. Each loop travels on its own: identical copies stay stacked, a
    // splitting shape pulls them apart.
    // Wherever the target is the ghost, the ghost with its hem turned by the
    // yaw stands in for it, so the scallops sweep round with the head. Blending
    // toward it, rather than switching it in on arrival, is what keeps the hem
    // continuous through a change.
    // A copy of an earlier loop is worked out once and handed on, all the way
    // through to the emitted string. So a whole shape costs one loop, not
    // three, and the exclamation mark costs two.
    const twins = twinsOf(this.morphFrom, this.morphTo, motion.loops);
    const sweep = yaw * TURN.hemShare;
    const swept = Math.abs(sweep) > 0.0005 && this.ghostLoops.some((g) => g !== null) ? ghostSpline(sweep) : null;
    const target = perLoop(twins, (i) => {
      const loop = this.morphTo[i]!;
      const g = this.ghostLoops[i];
      if (swept === null || g === null || g === undefined) return loop;
      const placed = translateLoop(swept, g.dx, g.dy);
      return g.twist === 0 ? placed : rotateSpline(placed, g.twist);
    });
    const blended = arrived
      ? target
      : perLoop(twins, (i) => lerpPath(this.morphFrom[i]!, target[i]!, morph));
    const parts = perLoop(twins, (i) => moveLoop(blended[i]!, motion.loops[i]!));
    this.drawnSpline = parts;
    const shapes = resting ? [REST.body] : perLoop(twins, (i) => mapPath(parts[i]!, field));
    const silhouette = resting
      ? AT_REST.body
      : perLoop(twins, (i) => emitPath(shapes[i]!)).join("");
    this.write(this.parts.bodyShape, silhouette);

    // Nothing is ever dropped. The head assembly and the tails are placed and
    // scaled to suit whatever the outline has become, and ride the loop the
    // layout names.
    const layout = blendFace(this.faceFrom, this.faceTo, morph);
    const face = rideFace(layout, motion.loops[layout.rides]?.shift ?? STILL.gaze);
    this.drawnFace = face;

    // The band is trimmed against the silhouette pulled in toward the head.
    // Deriving it from the shape that was just drawn is what keeps the two in
    // step: a separately blended mask drifts outside the body halfway through
    // a change and the band spills over the edge. Which point each loop is
    // pulled in toward is `bandMaskLoop`'s own business.
    const anchor = field({ x: face.x, y: face.y });
    const insetOf = (shape: readonly Segment[], i: number): string =>
      emitPath(bandMaskLoop(shape, i, parts, layout.rides, anchor));
    // A copy of an earlier loop nests about the same centre and insets to the
    // same string, so the mask costs no more distinct loops than the body did.
    const inset = (
      resting ? shapes.map(insetOf) : perLoop(twins, (i) => insetOf(shapes[i]!, i))
    ).join("");
    this.write(this.parts.headMask, inset);
    // The whole head assembly — visor, eyes, brows — is clipped to the same
    // inset outline, so however far the head turns, a rim of ink always stays
    // between the visor and the edge of the silhouette.
    this.write(this.parts.shapeClip, inset);

    // The band and the knot turn with the spin as well as the yaw; the face
    // turns with the yaw only, so while thinking it stays put under the ring.
    this.drawHead(field, face, yaw, yaw + spin, resting);
    this.drawFace(field, face, yaw, motion);
    this.drawTails(field, face, yaw + spin);
  }

  private write(target: SVGPathElement, d: string): void {
    if (target.getAttribute("d") !== d) target.setAttribute("d", d);
  }

  /** Re-emit the visor and the band, re-projected through the yaw. */
  private drawHead(
    field: (point: Point) => Point,
    face: FaceLayout,
    yaw: number,
    bandYaw: number,
    resting: boolean,
  ): void {
    const place = compose(field, compose(faceMap(face), yawWarp(yaw)));
    const placeBand = compose(field, compose(faceMap(face), yawWarp(bandYaw)));

    // The whole headband carries the colour, tails included.
    this.drawnBand = mixRgb(this.bandTo, this.bandFrom, clamp(this.bandBlend.value, 0, 1));
    const colour = rgbCss(this.drawnBand);
    for (const part of [this.parts.band, ...this.parts.tailFills]) {
      if (part.getAttribute("fill") !== colour) part.setAttribute("fill", colour);
    }

    // The eyes are not clipped to the visor. Their travel is bounded so they
    // stay inside it at any gaze — measured: 280 to 659 across and 491 to 641
    // down at full gaze and widest open, inside a visor spanning 238 to 704
    // and 447 to 651 — and a clip whose outline changes every frame is
    // re-rasterised every frame, which is what made the eyes flicker in some
    // browsers.
    this.write(this.parts.visor, resting ? AT_REST.visor : emitPath(mapPath(REST.visor, place)));

    // The band is a ring. At rest the ring's front half is the artwork; turned,
    // the visible half is whichever part of the ring now faces the viewer, so
    // its crest swings across the head and the knot's end goes round the back.
    //
    // The strip itself follows only the head's yaw, never the band's own turn.
    // The artwork places the strip so it clears the visor at every angle of
    // the front; turn the strip and the tilt of its back half comes round and
    // drops onto the eyes. So while thinking, only the knot travels round the
    // strip, and the strip stays exactly where it is drawn.
    this.write(
      this.parts.band,
      resting ? AT_REST.band : emitPath(mapPath(bandRing(yaw), compose(field, faceMap(face)))),
    );
    // The crease by the knot belongs to the knot: gone when the knot is behind,
    // and gone when the knot has left its place on the strip.
    const knotAngle = angleOf(ANCHOR.knot.x);
    const knotDepth = depthOf(knotAngle, bandYaw);
    const atHome = Math.abs(wrapAngle(bandYaw - yaw)) < 0.26;
    this.write(
      this.parts.bandShadow,
      resting ? AT_REST.bandShadow : knotDepth > 0 && atHome ? emitPath(mapPath(REST.bandShadow, placeBand)) : "",
    );
  }

  /**
   * Re-emit both eyes and both brows.
   *
   * They are built in the ghost's face space, then carried through two maps:
   * the head layout of whatever shape the silhouette is becoming, and the
   * deformation field. So the same blink, squint, and gaze drive a check
   * mark's eyes as drive the ghost's.
   */
  private drawFace(field: (point: Point) => Point, face: FaceLayout, yaw: number, motion: Gesture): void {
    // The warp goes on first, so the eyes re-project on the sphere before the
    // layout scales them onto the shape and the field bends the shape.
    const place = compose(field, compose(faceMap(face), yawWarp(yaw)));

    const life = this.motionSuppressed ? STILL : this.life;
    // The eyes drift only when nothing is aiming them. An aimed gaze is a
    // statement about the interface and must not wobble.
    const wander = this.gazeOverride === null ? life.gaze : STILL.gaze;
    const led = this.gazeOverride === null ? motion.gaze : STILL.gaze;
    const gaze = {
      x: this.gazeX.value + (wander.x + led.x) * LIMIT.gazeX,
      y: this.gazeY.value + (wander.y + led.y) * LIMIT.gazeY,
    };

    const lids = this.eyeShape.value * this.lid.value;

    for (const [target, anchor, ownLid] of [
      [this.parts.eyeLeft, ANCHOR.eyeLeft, 1],
      // The right eye has a lid of its own, for the wink.
      [this.parts.eyeRight, ANCHOR.eyeRight, this.wink.value * motion.wink],
    ] as const) {
      const open = clamp(lids * ownLid, 0.02, 1.3);
      // A narrowing eye keeps its mass, so a squint reads as a squint and not
      // as an eye that is disappearing.
      const rx = ANCHOR.eyeRadius * (1 + (1 - open) * 0.22);
      const ry = ANCHOR.eyeRadius * open;
      // A squint narrows from below — the cheek pushes the eye up — so the
      // eye's top edge holds and the bottom rises. A slit that stays centred
      // reads as sleepy; one that rises reads as a smile. A blink is a squint
      // too, so the lids meet a little above centre, where real lids do.
      const squint = (1 - Math.min(open, 1)) * ANCHOR.eyeRadius * 0.45;
      const at = { x: anchor.x + gaze.x, y: anchor.y + gaze.y - squint };
      // The local scale of the warp is the foreshortening: the eye going round
      // the far side narrows, the one coming to the front opens up. A little
      // perspective on top, so the near eye is also the bigger one.
      const eye = localScale(place, at);
      const near = 1 + TURN.perspective * (depthOf(angleOf(at.x), yaw) - depthOf(angleOf(at.x), 0));
      this.write(
        target,
        emitPath(ellipseShape(eye.centre.x, eye.centre.y, rx * eye.sx * near, ry * eye.sy * near)),
      );
    }

    const drift = { x: gaze.x * LIMIT.browFollow, y: gaze.y * LIMIT.browFollow };
    const shift = (p: Point): Point => ({ x: p.x + drift.x, y: p.y + drift.y });

    for (const [target, anchor, side] of [
      [this.parts.browLeft, ANCHOR.browLeft, 1],
      [this.parts.browRight, ANCHOR.browRight, -1],
    ] as const) {
      // The skew raises one brow and drops the other by the same amount.
      const brow = browShape(
        { outer: shift(anchor.outer), inner: shift(anchor.inner) },
        {
          innerDrop: this.browInnerDrop.value,
          lift: this.browLift.value + this.browSkew.value * side,
          bow: this.browBow.value,
        },
      );
      this.write(target, emitPath(mapPath(brow, place), false));
      const scale = localScale(place, anchor.outer);
      target.setAttribute(
        "stroke-width",
        (ANCHOR.browWidth * (scale.sx + scale.sy) * 0.5).toFixed(2),
      );
    }
  }

  /**
   * Put the tails behind the body or in front of it.
   *
   * Turning away, the knot goes round the back and the body has to hide it,
   * or a knot floating on the ink gives the turn away. Turning toward, it
   * comes round to the front and is drawn over the body.
   */
  private layerTails(behind: boolean): void {
    if (behind === this.tailsBehind) return;
    this.tailsBehind = behind;
    if (behind) this.parts.body.before(this.parts.tails);
    else this.parts.body.after(this.parts.tails);
  }

  /**
   * Re-emit both tails: bent around the knot, carried round the sphere with
   * it, and moved to the knot the shape wears.
   *
   * The knot is a point on the rim. Its yaw is the whole turn: the tails stick
   * out from the head, so they flatten as the knot swings toward the viewer and
   * open out again as it goes round the side; they grow coming forward and
   * shrink going back; and behind the rim they are drawn under the body.
   */
  private drawTails(field: (point: Point) => Point, face: FaceLayout, yaw: number): void {
    const knotAngle = angleOf(ANCHOR.knot.x);
    const depth = depthOf(knotAngle, yaw);
    // The knot rides the strip: as it travels round, it keeps the strip's
    // height at its angle, offset as the artwork offsets it, so the tails
    // always hang from the band and never from bare ink.
    const strip = ringAt(knotAngle + yaw);
    const knot = { x: project(knotAngle, yaw), y: (strip.top + strip.bottom) / 2 + KNOT_ON_STRIP };
    // How wide the tails are, seen from this angle — signed, so on the far
    // side of the head they point the other way, away from the face, and pass
    // through a sliver as the knot crosses the front.
    const flat = Math.sin(knotAngle + yaw) / Math.sin(knotAngle);
    const near = 1 + TURN.perspective * (depth - depthOf(knotAngle, 0));
    const carry = (point: Point): Point => ({
      x: knot.x + (point.x - ANCHOR.knot.x) * flat * near,
      y: knot.y + (point.y - ANCHOR.knot.y) * near,
    });
    const place = compose(field, compose(knotMap(face), carry));

    const write = (
      targets: readonly SVGPathElement[],
      sources: readonly (readonly Segment[])[],
      degrees: number,
      reach: number,
    ): void => {
      const bend = bendAround(ANCHOR.knot, degrees, reach);
      targets.forEach((path, index) => {
        const source = sources[index];
        if (source === undefined) return;
        const moved = mapPath(source, (point) => place(bend(point)));
        // The crease is an open stroke; the outline and the fill are closed.
        this.write(path, emitPath(moved, index < 2));
      });
    };

    write(this.parts.tailTop, REST.tailTop, this.tailTopBend.value, ANCHOR.tailTopReach);
    write(this.parts.tailBottom, REST.tailBottom, this.tailBottomBend.value, ANCHOR.tailBottomReach);

    const at = localScale(place, ANCHOR.knot);
    this.parts.knot.setAttribute("cx", at.centre.x.toFixed(2));
    this.parts.knot.setAttribute("cy", at.centre.y.toFixed(2));
    // The vertical scale carries the perspective; the horizontal one carries
    // the flattening, which a round knot does not take.
    this.parts.knot.setAttribute("r", (ANCHOR.knotRadius * at.sy).toFixed(2));
    this.layerTails(depth < 0);
  }

  // ------------------------------------------------------------ lifecycle

  setReducedMotion(on: boolean | null): void {
    this.reducedMotionOverride = on;
    this.onMotionContextChange();
  }

  private readonly onMotionContextChange = (): void => {
    this.element.dataset.reducedMotion = String(this.reducedMotion);
    this.clearBlink();
    this.clearCycle();
    if (this.motionSuppressed) {
      // An arrival caught mid-beat becomes the held shape of its state.
      this.entrySeq = null;
      this.blinkSeq = null;
      this.lean.target = 0;
      this.squash.target = 0;
      this.lift.target = 0;
      this.wink.target = 1;
      this.spin.target = Math.round(this.spin.target / (Math.PI * 2)) * Math.PI * 2;
      this.homeTurn();
      this.aimGaze();
      // A cycling state shows its still frame, not whichever shape it was on.
      if (this.definition.cycle !== undefined) this.beginMorph(this.definition.silhouette, CHANGE);
      this.wake();
      return;
    }
    // Motion is available again. A cycling state picks its cycle back up.
    this.scheduleBlink();
    const { cycle } = this.definition;
    if (cycle !== undefined) this.beginMorph(cycle.frames[this.cycleFrame]!, CHANGE);
    this.scheduleCycle();
    this.applyExpression();
    this.wake();
  };

  destroy(): void {
    this.destroyed = true;
    this.clearBlink();
    this.clearCycle();
    if (this.frame !== 0) this.view.cancelAnimationFrame(this.frame);
    this.reducedMotionQuery.removeEventListener("change", this.onMotionContextChange);
    this.document.removeEventListener("visibilitychange", this.onMotionContextChange);
    this.element.remove();
  }
}

/** Close the lids, then open them. The lid spring is stiff, so this is crisp. */
const BLINK: readonly Beat[] = [
  { at: 0, apply: (self) => void (self.lid.target = 0.04) },
  { at: TIMING.blinkClose, apply: (self) => void (self.lid.target = 1) },
];

/** Draw a mascot into `host` and return its control surface. */
export function createMascot(host: HTMLElement, options: MascotOptions = {}): Mascot {
  return new Runtime(host, options);
}
