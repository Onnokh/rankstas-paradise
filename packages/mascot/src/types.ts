/**
 * The semantic contract the mascot exposes to an application.
 *
 * Application code sets a state. It never touches the rig, the timings, or the
 * SVG parts. This keeps the contract stable when the implementation moves from
 * inline SVG to an authored runtime.
 */

/**
 * The five states. Each one has its own silhouette and its own motion in that
 * silhouette, and the mascot holds it until the application changes it.
 */
export type MascotState = "idle" | "thinking" | "loading" | "success" | "error";

/** A gaze direction, bounded to -1..1 on both axes. (0, 0) is straight ahead. */
export interface Gaze {
  readonly x: number;
  readonly y: number;
}

export interface MascotOptions {
  /**
   * Draw the coral app-icon tile behind the character.
   * Leave this off to put the character on a product surface.
   */
  readonly tile?: boolean;
  /** Start in the given state. Defaults to `idle`. */
  readonly state?: MascotState;
  /**
   * Force reduced motion on or off. When this is not set, the mascot follows
   * the `prefers-reduced-motion` media query and keeps following it.
   */
  readonly reducedMotion?: boolean;
  /** Accessible name for the SVG. Set to `null` to hide the SVG from assistive technology. */
  readonly label?: string | null;
}

export interface Mascot {
  /** The SVG element the mascot drew into its host. */
  readonly element: SVGSVGElement;
  /** The current state. */
  readonly state: MascotState;
  /** True while motion is suppressed (reduced motion, or a hidden document). */
  readonly reducedMotion: boolean;

  /**
   * Change the state. The silhouette morphs in place from whatever is on
   * screen, so any state can follow any other. Setting the same state again
   * does nothing.
   */
  setState(next: MascotState): void;
  /** Aim the gaze. Values outside -1..1 are clamped. */
  lookAt(gaze: Gaze): void;
  /** Aim the gaze at a viewport point, for example a pointer or a focused field. */
  lookAtPoint(clientX: number, clientY: number): void;
  /** Release the gaze and return the eyes to the state's own rest gaze. */
  releaseGaze(): void;
  /**
   * Turn the head, -1 (to the viewer's left) to 1 (to the viewer's right).
   *
   * A yaw, faked in two dimensions: the face slides across the silhouette, the
   * far eye narrows, and the knot swings behind the head on one side and
   * round to the front on the other. The mascot never rotates in the plane.
   */
  turnHead(yaw: number): void;
  /** Release the head and return it to the turn the state holds. */
  releaseTurn(): void;
  /** Blink once, now. */
  blink(): void;
  /** Override the reduced-motion decision. Pass `null` to follow the media query again. */
  setReducedMotion(on: boolean | null): void;
  /** Remove the SVG and release every timer, listener, and animation. */
  destroy(): void;
}
