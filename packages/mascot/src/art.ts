/**
 * The Ranksta rig.
 *
 * The paths come from `assets/appicon.svg`. That file is artwork, not a rig:
 * each eye is fused with its eyebrow into one compound path, and nothing is
 * named. Here the same character is split into a static half and a generated
 * half.
 *
 * Static: the coral tile, the visor, the acid band, the knot. Those shapes are
 * the identity and never change.
 *
 * Generated: the body silhouette, both eyes, both brows, and both headband
 * tails. Their `d` is rebuilt from numbers on every frame that moves, so the
 * character morphs between expressions instead of cross-fading between poses.
 */

/** The rig parts script rebuilds or moves. */
export interface RigParts {
  /** Horizontal lean. A transform, because a lean really is rigid. */
  readonly body: SVGGElement;
  /**
   * The silhouette, again, as a clip.
   *
   * Everything worn on the head is inside it — visor, eyes, brows, band. The
   * band's mask insets it from the outline to give the black rim, but a mask
   * and a silhouette are different shapes that only nest at the ends of a
   * morph; blend them independently and the band spills outside the black
   * halfway through. The clip makes containment structural, not hoped for.
   */
  readonly shapeClip: SVGPathElement;
  /** Everything the deformation field rewrites. */
  readonly bodyShape: SVGPathElement;
  readonly band: SVGPathElement;
  readonly bandShadow: SVGPathElement;
  readonly visor: SVGPathElement;
  readonly headMask: SVGPathElement;

  readonly eyeLeft: SVGPathElement;
  readonly eyeRight: SVGPathElement;
  readonly browLeft: SVGPathElement;
  readonly browRight: SVGPathElement;
  readonly knot: SVGCircleElement;
  /** The tails ride with the lean, then bend on their own. */
  readonly tails: SVGGElement;
  readonly tailTop: readonly SVGPathElement[];
  readonly tailBottom: readonly SVGPathElement[];
  /** The acid fill of each tail, so the whole headband can change colour together. */
  readonly tailFills: readonly SVGPathElement[];
}

/** Local origins and anchors the rig builds around, in viewBox units. */
export const ANCHOR = {
  /** The face sits a little left of the body centre. That is in the artwork. */
  mirrorX: 469.54,
  eyeLeft: { x: 363, y: 566 },
  eyeRight: { x: 576.08, y: 566 },
  /** Eye radius with the eye fully open. */
  eyeRadius: 47,
  /** Brow stroke width before the field stretches it. */
  browWidth: 26,
  /** Knot radius before the field stretches it. */
  knotRadius: 17.5566,
  browLeft: { outer: { x: 307, y: 503 }, inner: { x: 421.6, y: 503 } },
  browRight: { outer: { x: 632.08, y: 503 }, inner: { x: 517.48, y: 503 } },
  /** Both tails hinge on the knot. */
  knot: { x: 787.6, y: 441.4 },
  /** How far each tail reaches from the knot. A bend uses this to taper. */
  tailTopReach: 148,
  tailBottomReach: 186,
} as const;

export const INK = "#0B0A0B";
export const CORAL = "#FB3949";
export const ACID = "#C4FA04";
export const AMBER = "#FFB54A";
export const PAPER = "#FCFCFC";

/** The body silhouette at rest. Script re-emits it with a flowing hem. */
export const BODY_REST =
  "M179.649 454.022C179.649 371.725 212.342 292.798 270.535 234.605C328.728 176.412 407.655 143.719 489.952 143.719C572.25 143.719 651.176 176.412 709.37 234.605C767.563 292.798 800.255 371.725 800.255 454.022V806.788C800.255 823.031 793.803 838.608 782.317 850.094C770.832 861.579 755.254 868.032 739.011 868.032C702.265 868.032 663.069 810.871 627.955 810.871C596.108 810.871 538.947 883.547 489.952 883.547C440.957 883.547 383.796 810.871 351.949 810.871C316.836 810.871 277.64 868.032 240.893 868.032C224.65 868.032 209.073 861.579 197.587 850.094C186.102 838.608 179.649 823.031 179.649 806.788V454.022Z";

/** The hem is the free edge. These x positions sample its flow. */
export const HEM_STOPS = [179.649, 351.949, 489.952, 627.955, 800.255] as const;

/**
 * The landmarks the deformation field measures against, in viewBox units.
 *
 * The field is applied to every part of the character at once — silhouette,
 * band, visor, head mask, eyes, brows, knot, and tails — so the head can
 * change shape without the headband sliding off it.
 */
export const FRAME = {
  cx: 489.952,
  /** Half the body's width at the shoulders. The turn bulge measures against it. */
  halfWidth: 310.303,
  top: 143.719,
  /** Where the dome meets the straight sides. */
  shoulder: 454.022,
  bottom: 883.547,
  /** The height the hem waves collapse to when they flatten. */
  hemBaseline: 845,
  /** Where the hem shape starts to change, and where it changes fully. */
  hemShape: { from: 745, to: 884 },
  /** Where the cloth lag starts, and where it applies fully. */
  hemFlow: { from: 690, to: 884 },
} as const;

/**
 * How far the band is held inside the outline.
 *
 * The artwork masks the band against a circle of radius 289.07 while the body's
 * dome is radius 310.30 — so the mask is the silhouette scaled by their ratio
 * about its own centre. Deriving it that way means the mask always nests inside
 * the shape, whatever the shape is doing, and each loop of a split shape nests
 * inside its own piece.
 */
export const BAND_INSET = 289.07 / 310.303;

/**
 * The acid band.
 *
 * Its left end runs out to x=40, well past the artwork's 163. The band is
 * always masked, and on the ghost the head circle cuts it long before there —
 * so this changes nothing at rest. It matters on a narrow shape, where the
 * artwork's own end would fall *inside* the mask and show as a raw edge
 * instead of being trimmed to the outline.
 */
export const BAND_REST =
  "M40 308.67H241.71C367.464 277.64 694.099 326.635 784.74 432.791L788.823 473.62C596.15 414.549 390.788 410.589 195.981 462.188H40V308.67Z";

export const BAND_SHADOW_REST = "M694.099 413.193L772.083 441.365H798.214L694.099 413.193Z";

export const VISOR_REST =
  "M237.627 528.332C237.627 485.869 250.964 464.638 277.64 464.638C405.83 440.761 537.328 440.761 665.518 464.638C691.105 469.537 703.898 490.769 703.898 528.332C703.898 560.818 690.993 591.973 668.022 614.944C645.051 637.915 613.896 650.82 581.41 650.82H360.115C327.629 650.82 296.474 637.915 273.503 614.944C250.532 591.973 237.627 560.818 237.627 528.332Z";

/** Each tail is three paths: a black outline, an acid fill, and a crease. */
export const TAIL_TOP_REST = [
  "M792.089 379.713C808.421 359.298 841.085 342.967 885.997 336.434C912.944 341.333 906.411 383.796 885.997 408.293C869.665 428.708 841.085 447.49 812.504 447.49L799.439 446.265L792.089 379.713Z",
  "M792.089 379.713C808.421 359.298 841.085 342.967 885.997 336.434C912.944 341.333 906.411 383.796 885.997 408.293C869.665 428.708 844.759 439.732 816.179 439.732H793.722L792.089 379.713Z",
  "M834.552 398.494L793.722 437.691",
] as const;

export const TAIL_BOTTOM_REST = [
  "M805.155 460.555C792.089 488.319 796.172 529.148 832.919 555.279C865.582 568.344 898.246 583.043 912.944 578.144C921.11 545.48 898.246 488.319 845.984 460.555H805.155Z",
  "M805.155 454.022C792.089 481.786 796.172 522.616 832.919 548.746C865.582 561.812 898.246 576.51 912.944 571.611C921.11 538.947 898.246 481.786 845.984 454.022H805.155Z",
  "M801.072 456.472L827.203 477.703",
] as const;

const TILE =
  "M228.644 0H795.356C943.158 0 1024 80.8421 1024 228.644V795.356C1024 943.158 943.158 1024 795.356 1024H228.644C80.8421 1024 0 943.158 0 795.356V228.644C0 80.8421 80.8421 0 228.644 0Z";

/**
 * Build the rig markup. Generated paths start empty; the first draw fills them.
 *
 * @param id A per-instance prefix. Mask and clip ids must not collide when a
 *   page holds more than one mascot.
 */
export function rigMarkup(id: string, options: { tile: boolean }): string {
  const character = `
    <g class="rk-body" id="${id}-body">
      <path class="rk-body-shape" id="${id}-body-shape" fill="${INK}"/>

      <g class="rk-head" clip-path="url(#${id}-shape-clip)">
        <path class="rk-visor" id="${id}-visor" fill="${PAPER}"/>
        <g class="rk-face">
        <path class="rk-eye" id="${id}-eye-left" fill="${INK}"/>
        <path class="rk-eye" id="${id}-eye-right" fill="${INK}"/>
        <path class="rk-brow" id="${id}-brow-left" fill="none" stroke="${INK}" stroke-linecap="round"/>
          <path class="rk-brow" id="${id}-brow-right" fill="none" stroke="${INK}" stroke-linecap="round"/>
        </g>

        <g mask="url(#${id}-head-mask)"><path class="rk-band" id="${id}-band" fill="${ACID}"/></g>
        <path class="rk-band-shadow" id="${id}-band-shadow" fill="${INK}"/>
      </g>
    </g>

    <g class="rk-tails" id="${id}-tails">
      <g class="rk-tail" id="${id}-tail-top">
        <path fill="${INK}" stroke="${INK}" stroke-width="50" stroke-linejoin="round"/>
        <path fill="${ACID}"/>
        <path fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>
      </g>
      <g class="rk-tail" id="${id}-tail-bottom">
        <path fill="${INK}" stroke="${INK}" stroke-width="50" stroke-linejoin="round"/>
        <path fill="${ACID}"/>
        <path fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>
      </g>
      <circle class="rk-knot" id="${id}-knot" fill="${INK}"/>
    </g>`;

  const defs = `
    <defs>
      <mask id="${id}-head-mask" style="mask-type:luminance" maskUnits="userSpaceOnUse" x="120" y="60" width="784" height="784">
        <path id="${id}-head-mask-shape" fill="white"/>
      </mask>
      <clipPath id="${id}-shape-clip"><path id="${id}-shape-clip-shape"/></clipPath>
      <clipPath id="${id}-tile-clip"><path d="${TILE}"/></clipPath>
    </defs>`;

  if (!options.tile) return `${defs}<g class="rk-character">${character}</g>`;

  return `${defs}
    <path class="rk-tile" d="${TILE}" fill="${CORAL}"/>
    <g class="rk-character" clip-path="url(#${id}-tile-clip)">${character}</g>`;
}

/** Collect the addressable parts out of a rendered rig. */
export function readParts(root: SVGSVGElement, id: string): RigParts {
  const find = <T extends SVGElement>(suffix: string): T => {
    const node = root.querySelector<T>(`#${CSS.escape(`${id}-${suffix}`)}`);
    if (node === null) throw new Error(`Ranksta rig is missing the part "${suffix}".`);
    return node;
  };
  const tailPaths = (suffix: string): SVGPathElement[] => [
    ...find<SVGGElement>(suffix).querySelectorAll<SVGPathElement>("path"),
  ];

  return {
    body: find<SVGGElement>("body"),
    shapeClip: find<SVGPathElement>("shape-clip-shape"),
    bodyShape: find<SVGPathElement>("body-shape"),
    band: find<SVGPathElement>("band"),
    bandShadow: find<SVGPathElement>("band-shadow"),
    visor: find<SVGPathElement>("visor"),
    headMask: find<SVGPathElement>("head-mask-shape"),
    eyeLeft: find<SVGPathElement>("eye-left"),
    eyeRight: find<SVGPathElement>("eye-right"),
    browLeft: find<SVGPathElement>("brow-left"),
    browRight: find<SVGPathElement>("brow-right"),
    knot: find<SVGCircleElement>("knot"),
    tails: find<SVGGElement>("tails"),
    tailTop: tailPaths("tail-top"),
    tailBottom: tailPaths("tail-bottom"),
    // The second path of each tail is its fill; the first is the outline.
    tailFills: [tailPaths("tail-top")[1]!, tailPaths("tail-bottom")[1]!],
  };
}
