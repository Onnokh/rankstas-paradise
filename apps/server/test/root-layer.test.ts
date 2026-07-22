// Single-instantiation evidence for PLO-276.
//
// main.ts launches ONE root Layer under a single long-lived runtime
// (`Layer.launch` + `BunRuntime.runMain`). The guarantee that matters is that a
// service reached through several paths in that graph is still built exactly
// once — Layer memoization within a runtime's memo map. This test pins that
// property with a construction counter over a diamond (two dependents share one
// probe): the probe must build once, no matter how many times it is resolved.
//
// The per-site `ManagedRuntime`s (runtime.ts) are intentionally one-per-site and
// are deliberately NOT covered here.
import { expect, test } from "bun:test"
import { Context, Effect, Layer, ManagedRuntime } from "effect"

class Probe extends Context.Service<Probe, { readonly n: number }>()(
  "test/Probe",
) {}
class Left extends Context.Service<Left, { readonly ok: true }>()("test/Left") {}
class Right extends Context.Service<Right, { readonly ok: true }>()(
  "test/Right",
) {}

test("root layer builds a shared dependency exactly once", async () => {
  let builds = 0
  const ProbeLayer = Layer.effect(
    Probe,
    Effect.sync(() => {
      builds += 1
      return { n: builds }
    }),
  )
  const LeftLayer = Layer.effect(
    Left,
    Effect.gen(function* () {
      yield* Probe
      return { ok: true as const }
    }),
  )
  const RightLayer = Layer.effect(
    Right,
    Effect.gen(function* () {
      yield* Probe
      return { ok: true as const }
    }),
  )

  const root = Layer.mergeAll(LeftLayer, RightLayer).pipe(
    Layer.provide(ProbeLayer),
  )
  const runtime = ManagedRuntime.make(root)
  try {
    // Resolve every dependent, more than once, from the one runtime.
    await runtime.runPromise(Effect.all([Left, Right]))
    await runtime.runPromise(Effect.all([Left, Right]))
    expect(builds).toBe(1)
  } finally {
    await runtime.dispose()
  }
})
