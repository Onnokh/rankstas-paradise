# @rp/mascot

The Ranksta mascot as a rigged inline SVG with a small semantic control surface.
No dependencies, no runtime download, no canvas.

```ts
import { createMascot } from "@rp/mascot";

const mascot = createMascot(document.querySelector("#portrait")!, { tile: true });

mascot.setState("loading");   // one of five states, held until it changes
mascot.setState("success");   // any state can follow any other
mascot.lookAtPoint(x, y);     // bounded gaze, viewport coordinates
mascot.turnHead(-0.6);        // a yaw, -1 to 1; releaseTurn() hands it back
mascot.destroy();             // removes the SVG, timers, and listeners
```

## Five states, five silhouettes

Each state has its own silhouette and its own motion in that silhouette. The
black shape morphs in place from one to the next, and the character — visor,
eyes, brows, acid band, knot, tails — rides along, placed and scaled to suit.

| State | Silhouette | Why | Motion in it |
| --- | --- | --- | --- |
| `idle` | The ghost, as drawn | At rest the character is the brand icon and has nothing to say. | Breath, sway, hem stir, roving eyes, irregular blink, and a slow irregular drift of the head, the way attention wanders. |
| `thinking` | A circle | A head with room in it, and the state is in the headband: the knot and tails travel slowly round it, go round the back and come out the other side, over and over. Machinery turning inside the head. The circle is the dome's own radius, so the band's rim is the body's rim and the knot surfaces at the edge. | One revolution in about five seconds, and the head sways with it once per revolution, the eyes looking up and following. The strip itself stays where the artwork puts it, clear of the eyes; only the knot travels, with the tails pointing away from the face on either side. One brow up, one down. |
| `loading` | A cycle: triangle, square, bar, play | Work in progress is change without arrival, and a spinner would need the rotation the character is not allowed. None of the four is a state's own shape. | Every 640 ms, on a fixed beat, the silhouette jumps to the next shape in place, landing with a stretch and a squash. The head holds still through it: this state is shapes, nothing else. Under reduced motion nothing may jump, so it holds three dots — the ellipsis. |
| `success` | A diamond | Joy is jumping in every culture, and the diamond is the shape with a point to jump on. | Hops the whole time, four a cycle: a stretch in the air, a press on landing, the head wiggling with it. A wink once a cycle. |
| `error` | An exclamation mark | The universal error glyph. | Arrives shaking its head "no": three swings, decaying. Once a cycle the mark is thumped — the bar drops, the point swells, the head shakes "no" again; the band and tails go amber. |

Each state is one file in [`states/`](src/states): its arrival beats and its
held gesture live there, and the gesture is clocked by the state's own
`life.period`, so gesture and breath never fall out of step. A
gesture is weighted by the morph, so it fades in as the shape arrives and never
fights the change — and a change departs from the silhouette on screen, gesture
included, so leaving `loading` mid-wave shows no snap.

## Nothing here is a stored pose

A state is not a picture. It is a set of shape parameters — brow drop, brow
lift, brow bow, eye openness, rest gaze — carried by springs. Every frame that
moves re-emits the geometry from wherever the springs currently sit, so any two
states have an unbroken run of real shapes between them. The character morphs;
it never cross-fades.

That applies to all of it:

| Part | What is generated |
| --- | --- |
| Silhouette | A blend between the loops of two states, then a field — height, width, hem, crown, crown tilt, squash — over the result. |
| Hem | Five springs chase the body; what gets drawn is how far behind each has fallen, so the cloth trails and catches up. |
| Brows | A curve, not a rotated bar. The bow reshapes it from a scowl to an arch. |
| Eyes | An ellipse. A blink is a circle collapsing to a slit, and a squint keeps the eye's mass by widening as it narrows. |
| Tails | Bent around the knot, so they curl along their length instead of pivoting. |

### One field, applied to everything

The silhouette cannot be deformed on its own. Move the body and the headband
slides off the head. So the deformation is a single function in
[`deform.ts`](src/deform.ts), applied to every point of every part in the same
frame: body, band, band shadow, visor, head mask, eye centres, brow
anchors, knot, and both tails. The character deforms whole.

The field never authors a second silhouette. It moves the points of the
source artwork, transcribed into [`art.ts`](src/art.ts), so every shape it
produces is a real deformation of that artwork.
At rest it is the identity, and the rig re-emits the source artwork exactly.
Exactly means at the rig's own precision: paths are emitted to two decimal
places, and the artwork carries three, so `179.649` comes back as `179.65`. The
resting shape is the artwork re-emitted, not the artwork's own string.

Only the coral tile is left out, because the character has to be able to sit on
any surface.

Two of the field's channels are held at zero by every state today: the hem's
shape and the crown's point and tilt. They are not dead weight. The breath runs
through the same field's height and width, so the field itself is never
optional, and each unused channel tests for zero before it does any work. The
same goes for the held turn in an expression. They are room the rig keeps for a
state that needs it.

The amplitudes in `SILHOUETTE_GAIN`, `TURN`, and the gestures are all bounded
by the tile: the shape, its arrival beat, its gesture, and the ambient breath
stack, and the tile clips. Measured worst cases, on painted ink only, over each
state entered from each of the other four and then held for a minute:

| State | Tightest margin | Binds on | When |
| --- | --- | --- | --- |
| `idle` | 70 | tail outline, right | held 43.8 s, from `thinking` |
| `thinking` | **24** | tail outline, left | held 8.0 s, from `loading` |
| `loading` | 96 | tail outline, right | first frame of the arrival |
| `success` | 71 | tail outline, right | held 0.1 s, mid-hop |
| `error` | 100 | tail outline, right | first frame of the arrival |

Nothing is clipped, but `thinking` is the tight one, at about 2 % of the
canvas. It binds eight seconds in, when the turning band has carried the knot
round to the left of the head and the tails swing out that side. A sample
shorter than one band revolution never reaches it, which is why the number used
to read as the loosest in this table rather than the tightest.

Four things to know before measuring it again:

- **Measure painted ink, not paths.** The tail outline is stroked 50 units wide
  with a round join, so it lays ink 25 units past its own path. Counting path
  geometry alone gives 95, 49, 136, 96 and 118 — a flat 25 units of comfort
  that is not there.
- **Leave the band, the mask, the clip, and the tile out.** The band's own path
  runs far past the outline on purpose and is masked, so a bounding box that
  includes it reports an overflow that does not exist. The tile's clip path is
  the whole canvas and reports a margin of zero.
- **The tails are almost always the binding constraint.** They already hang
  past the outline at rest, so the turn's swell fades outside the body's
  half-width and they grow far less coming forward than they shrink going
  behind.
- **`loading` and `error` bind on the first frame of their arrival**, where
  what is on screen is still the shape being left. Held, their own worst cases
  are 112 and 121.

## What it does

| Behaviour | Rule |
| --- | --- |
| Blink | Irregular, every 4–9 s. The eyes spend nearly all their time open. |
| Gaze | Bounded to about 2.5 % of the canvas. It drifts when nothing is aiming it, and holds still when something is. |
| Body | Horizontal lean up to 2 %; squash and stretch up to 2 %. Never a rotation. |
| Change | In place, about 200 ms, no wind-up. `success` adds a press into its hopping, `error` a three-swing head shake. |
| Turn | A yaw on a spherical head model, up to 45°. Idle drifts slowly; thinking sways with the band turning round its head; success hops and wiggles; error shakes its head, on arrival and once a cycle; loading holds still. `turnHead` overrides all of it. |
| Band colour | Acid at rest. `error` takes the band and both tails to amber, in about 130 ms. |

## A held state is not a still frame

Each state breathes at its own rate and with its own weight, and makes its own
gesture in its own shape, so the mascot reads as alive, and as *this* state,
even when nothing is happening. The signal is a set of slow sines
on height, width, sway, hem stir, and gaze drift, at frequencies that do not
divide evenly into each other, so the loop cannot be heard. See each state's `life` in [`states/`](src/states).

The ambient values are added to what gets drawn, never to the spring targets: a
target the springs chase would lag and smear the pulse.

Because of this the render loop does not shut down while the mascot is visible.
It costs a full 60 fps and stops the moment motion is suppressed. **If you put
this on a product surface, that is continuous motion alongside other content —
WCAG 2.2.2 wants a control to pause, stop, or hide it. Respecting
`prefers-reduced-motion` is the baseline; an in-page control may still be
needed.**

The loop starts when the mascot is built, not when something first happens to
it. It also runs on every mascot on the page at once, so two things in the hot
path are worth knowing:

- **Identical loops are drawn once.** A whole silhouette is three copies of one
  shape, which the fill rule renders once, and the body, the mask, and the clip
  all derive from the same three. Each distinct loop is now blended, moved,
  mapped through the field, and emitted once and reused. Measured over a run of
  every state: 8,776 of 16,326 loop computations reused, which is what a mix of
  whole shapes and split ones should give.
- **The turned hem is remembered.** Rebuilding the ghost with its hem swept is
  the heaviest pure function in the rig, and a turning head asks for a new one
  every frame. The last one built is kept, keyed on the sweep rounded to
  0.0004 rad. Measured across the live sweep range, 12.46 µs per call becomes
  1.86; on a yaw the application holds, 0.11. The rounding moves a scallop by
  at most 0.047 units, about a seventieth of a pixel at a 300 px render.

Neither changes a single emitted path. Both were checked by rendering every
state over thousands of frames with and without them and comparing the output
byte for byte.

## Changing the silhouette

A state change morphs the black shape point for point. **Nothing is dropped.**
The visor, eyes, brows, acid band, knot, and tails all travel with it — a
hopping diamond is still Ranksta, wearing his headband.

### A morph happens where it stands

Everything here is measured off the reference rather than guessed at. Frames
were pulled at 60 fps and reduced to per-frame shape metrics — bounding box,
area, centroid.

| Measured | Reference |
| --- | --- |
| Horizontal drift of the centroid through a shape change | under 1 % of frame |
| Wind-up before the change | none |
| Hexagon settling into a triangle | looks finished in 200 ms |
| Bar opening into a circle | 99 % in 420 ms |
| Overshoot | none, in any transition |

Both timings fit one critically damped spring at about omega 15.7 — the small
change simply hides its own tail. That is `SPRING.morph`.

So a morph is a direct spring to the new shape, with no anticipation and no
travel. The only overlays are a short squash through the change and a small
glance that decays out of it. Ranksta's own measured drift: 0.7 % on the
centred shapes, against 0.4 % for the ambient breath alone.

**The twist matters.** Blend two loops whose start points line up and every
point takes the shortest route, which reads as a crossfade of two outlines.
Offsetting the target's start by a few percent of the point count makes the
outline travel round itself, so the intermediates come out lopsided and organic
the way the reference's do. `MORPH_TWIST.offset`. The offset changes the
parameterisation, not the shape, so the destination is unaffected. A loop that
is *not* changing shape — the ghost's body when a state only moves it — gets
no twist, or it would swirl round itself for no reason.

The turn is a real projection, not a slide. The head is treated as a sphere of
the dome's radius about the body's axis. Every head point has an angle on that
sphere — its rest position is the front view, so the angle is just the arcsine
of its offset — and a yaw re-projects it: `x = axis + radius · sin(angle +
yaw)`. Heights do not change. Everything follows from that one rule:

- the visor and the eyes slide toward the far rim and **compress** as they go,
  because the local scale of the projection is the foreshortening; the near
  eye opens up and, with a little perspective, grows;
- the band is a **ring**. Its front half is sampled from the artwork once, the
  back half mirrors it, and each frame draws whichever half now faces the
  viewer. So the band's slope changes with the turn and its high end swings
  across the outline instead of the band just shifting sideways. Past the rim
  of the head sphere the strip carries straight on along its slope, far enough
  to cross any body the silhouette has become, and the inset mask trims it to
  that body — the head sphere is the body's rim only for the ghost and the
  circle, and on a diamond a band that stopped at the sphere left a wedge of
  ink before the edge;
- the knot is a point on the rim. Turning away it goes round the back and the
  body is drawn over it; turning toward it comes round to the front, drawn over
  the body. That layer swap is the only DOM reorder in the rig;
- the tails stick out from the head, so they **flatten** as the knot swings
  toward the viewer, pass through a sliver at the front, and open out again on
  the other side pointing the other way, away from the face; they grow coming
  forward and shrink going back;
- the head's silhouette does not change — a round head has the same outline
  from every angle — but the ghost's **hem sweeps**. The ghost is built from
  its measurements (a semicircular dome on straight sides, within a fifth of a
  unit of the artwork), and its scallops are read off the artwork once as a
  pattern round the rim of the skirt and repeated round the back. A turn reads
  that pattern from a new angle, so new scallops come into view on one side as
  others go round the other, and the outline's sides stay where they are.

It is a head turn. The mascot never rotates in the plane. Most states use it
as part of what they are doing — the gesture in [`states/`](src/states)
carries a yaw alongside the loop motion, and the arrival beats turn the head
too. `turnHead` lets the application hold any amount up to 45° and wins over
all of that; `releaseTurn` hands it back.

### Three things make the shape change work

- **Matched topology.** Every shape, the ghost included, is resampled to 128
  evenly spaced points, **turned clockwise**, and rebuilt as a closed spline in
  [`shapes.ts`](src/shapes.ts). Blending is one lerp per point, with nothing
  to reconcile at run time. The resampled ghost holds the exact artwork to 0.15
  of a viewBox unit at the shared points, and 0.53 at the worst place on the
  curve between them, so entering a morph shows no step, and rest still emits
  the artwork itself.

  The winding matters. Blend a clockwise loop with a counter-clockwise one and
  the shape folds through itself and collapses halfway. The artwork's head
  circle happens to be drawn the other way round from everything else, so
  `orientClockwise` normalises every loop before it is splined.
- **A head layout per shape.** `FaceLayout` says where the head assembly sits,
  how big it is, and where the knot hangs. The assembly keeps its own
  proportions, so the same blink, squint, and gaze drive a triangle's eyes as
  drive the ghost's.
- **The band's mask is derived from the silhouette, never blended alongside
  it.** The artwork masks the band against a circle of radius 289.07 while the
  body's dome is radius 310.30, both centred on the shoulders — so the mask is
  just the silhouette scaled by their ratio about that centre (`BAND_INSET`).

  Deriving it is not a shortcut, it is the fix. A mask and a silhouette are
  different shapes that only nest at the two ends of a morph; blend them
  independently and halfway through the mask sits outside the body and the band
  spills over the edge. Deriving it from the shape that was just drawn makes
  nesting automatic.

  The loop the head rides — and any copy of it stacked on top of it — is
  pulled in toward the head itself; every other loop toward its own centre. A
  concave shape does not nest inside itself when scaled about its bounding
  box, but it does nest locally about any point in the thick of its own ink,
  and the head is the only place the band is. Measured on a concave loop built
  the way the states build theirs: 18 of 128 mask points outside the body
  about its box centre; about a point in the ink, zero.

  **The anchor is only taken when the loop really holds it.** Trusting the
  layout alone put the anchor outside the loop it was insetting, and a shape
  scaled about a point outside itself does not nest at all. Two ways that
  happened, both found by test rather than by eye:

  - A copy that is the same shape *moved* is a separate piece, not a copy. The
    ellipsis's outer dots are the middle dot, 262 units to each side, and the
    head sits on the middle one. Measured: 55 of 128 mask points outside each
    outer dot.
  - The layout names its loop from the *target* of a change as soon as the
    change starts, so part-way through the morph that leaves the ellipsis the
    head was said to ride a loop it had not reached yet. Measured a twentieth
    of the way in: 108 of 128 points outside, with the band by then wide
    enough to paint the ground they escape over.

  **Local nesting is local.** The ghost is the only concave silhouette, and at
  a full turn its swept scallops reach far enough from the head that up to 6 of
  128 mask points fall outside the hem. Every one of them is below y 800, at
  the bottom of the skirt, and the band's own lowest reach is more than a
  hundred units above that, so nothing can be painted there. The clearance is
  held by a test rather than by luck.

  Everything worn on the head — visor, eyes, brows — is clipped to that same
  inset outline. So however far the head turns, the visor never reaches the
  edge: a rim of ink always stays between the face and the silhouette. The
  eyes are *not* clipped to the visor: their travel is bounded to stay inside
  it, and a clip whose outline changes every frame is re-rasterised every
  frame, which made the eyes flicker in some browsers.

A morph always departs from the silhouette on screen, so going straight from
one state to another does not detour through the ghost.

### Shapes that split

An exclamation mark is not one outline. Rather than bridge its bar and its
point with a hairline, the silhouette is
*always* drawn as `PARTS` loops — three of them. A single shape is three
identical copies, which the nonzero fill rule renders once. A shape that splits
pulls the copies apart. So every silhouette shares one topology, single or
split, and blending needs nothing new: each copy travels on its own, and the
ghost visibly drops a lobe to become the exclamation's point.

The band's mask follows: each loop is inset about **its own** centre. Inset
toward the canvas centre and a dot that sits off to one side is dragged out past
its own edge — measured, 57 of 128 mask points outside the body. About its own
centre: zero.

Each loop is also aligned about its own centre before splining, or an off-centre
loop's start point lands wherever happens to face left of the canvas and that
copy picks up a twist nobody asked for.

## Colour on the band

The band is the one part of the character that can carry a colour without
touching the interface around it, so a state's `band` is where it gets to say
something in colour. Acid is the resting colour and means nothing on its own; a
state that differs from it is making a claim. Only `error` does.

Two things this cost to get right:

- **It has to arrive.** The tint spring is stiff — about 130 ms — because a
  colour that eases in spends the whole change somewhere in between, and a
  band that is half acid and half amber says nothing.
- **Amber, not coral.** Coral is the error colour in the palette, but it is
  also the app-icon tile. A coral band on a coral tile disappears and the tails
  read as holes punched in the shape. Amber carries the same alarm and holds
  against the tile and a dark surface alike.

Colour is a second signal, never the only one — the state text stays the source
of truth.

## The contract

The application sets a state. It never touches the rig, the timings, or the
SVG. When the character later moves to an authored runtime, the same calls stay
valid.

Motion supports the interface; it never carries state on its own. Keep the state
in ordinary text — the mascot's SVG is `aria-hidden` unless you pass a `label`.

## Accessibility

The mascot follows `prefers-reduced-motion` and keeps following it. Under reduced
motion:

- the ambient breath stops completely, and the rig emits the artwork itself;
- gaze following and gaze drift stop, and the eyes hold the shape of the state;
- blinking stops;
- a state change is an instant held shape rather than a morph, with no
  arrival beat and no gesture;
- shapes change with no travel, because the springs settle in place;
- a mascot **built** straight into a state arrives at it, colour included. This
  is the one path with no frames to carry it, so the springs settle at
  construction. Without that, `error` drew the acid band it was leaving and
  never corrected, which took the colour off the one state that carries any.

Motion also stops while the document is hidden.

## The files

- [`states/`](src/states) — one file per state. Each is a `StateDefinition`:
  the silhouette it holds and where the character sits on it, the face, the
  band colour, the breath, the beats that overlay its arrival, and the gesture
  it makes while held. A cycling state also declares its frames and tick; a
  state with a turning band declares the speed. `definition.ts` is the
  contract and the shared pieces (the change beat, the look-around). Adding a
  state is a file here and a line in `index.ts`; the runtime never learns its
  name.
- [`shapes.ts`](src/shapes.ts) — how silhouettes are built: the shared
  resampling, the loop builders, the ghost from its measurements with a hem
  that turns.
- [`motion.ts`](src/motion.ts) — the rig's own numbers: bounds, the shared
  beat lengths, spring constants, the turn model, and what an expression and a
  breath are made of.
- [`geometry.ts`](src/geometry.ts) — path arithmetic: parse, map, emit; the bend
  field; the ellipse and brow builders.
- [`loops.ts`](src/loops.ts) — the algebra of the three-loop silhouette and of
  placing the head on it: which loops are copies, how a loop moves, how a face
  layout carries the head assembly, and how the band's mask is derived.
- [`head.ts`](src/head.ts) — the head as a sphere, and the yaw that turns it:
  the projection, the band ring, and the knot on the rim.
- [`deform.ts`](src/deform.ts) — the character field and the local-scale probe
  that keeps a circle round when the space around it stretches.
- [`art.ts`](src/art.ts) — the rest shapes, the anchors, the frame landmarks,
  and the markup with empty slots for everything generated.
- [`mascot.ts`](src/mascot.ts) — the runtime: the springs, the render loop, and
  the drawing. It reads the definition of the state in force and has no
  state-specific code.
- [`test/`](test) — the suite. Everything outside `mascot.ts` is a pure
  function or plain data, so most of the rig is measured without a DOM.

CSS carries no motion at all, so there is no second owner that could fight the
render loop or leave a transition running across a state the springs have left.

## Tests

```bash
bun run test          # every package
bun run test:mascot   # this one
```

`mascot.ts` needs a DOM, and everything else is a pure function or plain data.
So the shapes, the path arithmetic, the deformation field, the loop algebra,
the head model, and the state definitions are all measured directly, and the
runtime is driven against a small documented fake DOM in
[`test/fake-dom.ts`](test/fake-dom.ts).

The suite exists because this rig was built by eye, and a change that helps one
state quietly breaks another. Each group guards a defect that reached the
screen at least once:

| Group | What it holds |
| --- | --- |
| `shapes` | Every shape resamples to one command list, so any state can morph into any other. The procedural ghost still reproduces the artwork. |
| `loops` | The band's mask nests inside the body — for every state, and through all 25 ordered changes, at several points mid-morph. |
| `head` | The band never crosses the eyes, it reaches past the rim on both sides, and the knot rides the strip out to the body's edge. |
| `deform` | The field is exactly the identity at rest, which is what lets the rig re-emit the artwork unchanged. |
| `states` | Every gesture stays inside its documented bounds over its own cycle, and is the null gesture at weight zero. |
| `runtime` | A mascot built straight into a state shows that state, the loop runs, every change lands, and `destroy` releases everything. |

## Playground

```bash
bun run playground
```

Then open the printed URL to exercise every state, the gaze, and the
reduced-motion path. See [`apps/mascot-playground`](../../apps/mascot-playground).
