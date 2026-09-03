/**
 * The character deformation field.
 *
 * One function, applied to every point of every part: silhouette, band, visor,
 * head mask, eyes, brows, knot, and tails. That is the whole reason the head
 * can change shape at all — deform the body alone and the headband slides off
 * it. Deform everything through the same field and the character stays whole.
 *
 * The field never authors a second silhouette. It moves the points of the one
 * in `appicon.svg`, so every shape it produces is a real deformation of the
 * artwork rather than a different drawing blended on top.
 */

import { FRAME, HEM_STOPS } from "./art.ts";
import { sampleField, smoothstep, type Point } from "./geometry.ts";
import { SILHOUETTE_GAIN } from "./motion.ts";

/** What the silhouette is doing right now. Every value is spring-carried. */
export interface Deformation {
  /** Taller or shorter, measured from the feet. */
  readonly height: number;
  /** Wider or narrower, more so at the base than at the crown. */
  readonly width: number;
  /** The hem waves: -1 flattens them to a straight edge, +1 deepens them. */
  readonly hem: number;
  /** The crown: +1 draws it to a point, -1 broadens it. */
  readonly peak: number;
  /**
   * How far the crown bends to one side, in viewBox units. Nothing below the
   * shoulders moves. A crown drawn to a point and bent over is a thinking cap.
   */
  readonly tilt: number;
  /** The reaction channel. Fast, small, and folded into height and width. */
  readonly squash: number;
  /** How far each hem node has fallen behind the body, in viewBox units. */
  readonly trail: readonly number[];
  /** How far each hem node has fallen behind the body's rise and fall. */
  readonly ripple: readonly number[];
}

/** True when the field would return every point unchanged. */
export function isRest(d: Deformation): boolean {
  const flat = (values: readonly number[]) => values.every((v) => Math.abs(v) < 0.01);
  return (
    Math.abs(d.height) < 0.001 &&
    Math.abs(d.width) < 0.001 &&
    Math.abs(d.hem) < 0.001 &&
    Math.abs(d.peak) < 0.001 &&
    Math.abs(d.tilt) < 0.001 &&
    Math.abs(d.squash) < 0.0001 &&
    flat(d.trail) &&
    flat(d.ripple)
  );
}

/**
 * Build the field for one frame.
 *
 * The steps run from the hem upward, so a later step reads the position an
 * earlier one produced. Reordering them changes the character.
 */
export function characterField(d: Deformation): (point: Point) => Point {
  const heightScale = (1 + SILHOUETTE_GAIN.height * d.height) * (1 - d.squash);
  const widthScale = 1 + SILHOUETTE_GAIN.width * d.width + d.squash * 0.7;
  const hemPull = d.hem < 0 ? -d.hem * SILHOUETTE_GAIN.hemFlatten : -d.hem * SILHOUETTE_GAIN.hemDeepen;

  return (point: Point): Point => {
    let { x, y } = point;

    // 1. The hem waves flatten out or dig deeper.
    if (hemPull !== 0) {
      const w = smoothstep(FRAME.hemShape.from, FRAME.hemShape.to, y);
      if (w > 0) y += (FRAME.hemBaseline - y) * hemPull * w;
    }

    // 2. The cloth lag: the free edge trails whatever the body just did.
    const flow = smoothstep(FRAME.hemFlow.from, FRAME.hemFlow.to, y);
    if (flow > 0) {
      x += sampleField(HEM_STOPS, d.trail, x) * flow;
      y += sampleField(HEM_STOPS, d.ripple, x) * flow;
    }

    // 3. The crown draws to a point, or broadens. Nothing below the shoulders moves.
    if (d.peak !== 0 || d.tilt !== 0) {
      const w = smoothstep(FRAME.shoulder, FRAME.top, y);
      if (w > 0) {
        x = FRAME.cx + (x - FRAME.cx) * (1 - SILHOUETTE_GAIN.peakNarrow * d.peak * w);
        y -= SILHOUETTE_GAIN.peakRise * d.peak * w;
        // The bend: the crown leans over, more the higher up it is.
        x += d.tilt * w * w;
      }
    }

    // 4. There is no turn step. A yaw is a rotation of a round head about its
    //    own axis, and the silhouette of a round head does not change when it
    //    turns; the head parts re-project on the sphere instead (see the yaw
    //    model in head.ts). Leaning or swelling the body here only made the
    //    face look painted on.

    // 5. Width, weighted toward the base: widening reads as planting itself.
    const depth = smoothstep(FRAME.top, FRAME.bottom, y);
    const reach = SILHOUETTE_GAIN.widthBase + (1 - SILHOUETTE_GAIN.widthBase) * depth;
    x = FRAME.cx + (x - FRAME.cx) * (1 + (widthScale - 1) * reach);

    // 6. Height, measured from the feet, so the character grows upward.
    y = FRAME.bottom + (y - FRAME.bottom) * heightScale;

    return { x, y };
  };
}

/**
 * How much the field stretches space at one point.
 *
 * A circle drawn at a deformed anchor has to be stretched by the same amount,
 * or an eye keeps its rest size on a head that has changed shape.
 */
export function localScale(
  field: (point: Point) => Point,
  at: Point,
): { readonly centre: Point; readonly sx: number; readonly sy: number } {
  const step = 8;
  const centre = field(at);
  return {
    centre,
    sx: (field({ x: at.x + step, y: at.y }).x - centre.x) / step,
    sy: (field({ x: at.x, y: at.y + step }).y - centre.y) / step,
  };
}
