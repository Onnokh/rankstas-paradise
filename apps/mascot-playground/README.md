# apps/mascot-playground

A browser playground for [`@rp/mascot`](../../packages/mascot). Bun bundles the
HTML entry and its TypeScript, so there is no bundler and no build step.

```bash
bun run playground
```

**Start with the state grid.** Every state holds side by side on one clock, so
a change can be judged against all of them at once — a tweak that helps the
loading shapes can quietly ruin the exclamation mark, and one button press at a
time will not show you that. *Re-enter the states* sends every cell to idle and
straight back, so all five arrivals play together; *Loop through idle* keeps
doing it.

Use it to check the motion language before the character moves to an authored
runtime:

- hold each state and watch the gesture in its shape: the ghost looks around,
  the band turns round the circle, the loading shapes jump on the beat, the
  diamond hops, the exclamation mark thumps;
- change state and watch the morph: it happens where it stands, with no
  wind-up. `success` adds a press before it starts hopping, `error` a
  three-swing head shake and an amber band;
- go straight from one state to another — nothing detours through the ghost;
- move the pointer to test the gaze bounds, then release it;
- drag the yaw slider, or run *Sweep*, *Shake no*, or *Peek*: every mascot on
  the page turns together, so the knot going behind the head on one side and
  round to the front on the other can be judged on every silhouette;
- switch the coral app-icon tile off to see the character on a bare surface;
- watch one state for a while: it never holds the same frame twice;
- force reduced motion, or emulate `prefers-reduced-motion: reduce` in the
  browser, and confirm each state is a still, readable shape.

The state text is the source of truth. Motion only ever agrees with it.
