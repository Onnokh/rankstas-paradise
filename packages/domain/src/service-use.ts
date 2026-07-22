// The `serviceUse` accessor. Calling a service method normally means
// `yield* Service` then calling the method; `serviceUse` collapses that into a
// single call so consumers can write `Sites.use.loadSites()`.
//
// Every module exposes `export const use = serviceUse(Service)`. Two call
// styles then coexist: pull the whole service inside a layer (`yield* X.Service`)
// or call one method from a consumer (`yield* X.use.method(args)`).
import { Context, Effect } from "effect"

// Maps each Effect-returning method of a service `Shape` to an accessor with the
// same arguments, adding the service `Identifier` to the effect's requirements.
export type ServiceUse<Identifier, Shape> = {
  readonly [K in keyof Shape]: Shape[K] extends (
    ...args: infer A
  ) => Effect.Effect<infer O, infer E, infer R>
    ? (...args: A) => Effect.Effect<O, E, R | Identifier>
    : never
}

export const serviceUse = <Identifier, Shape>(
  tag: Context.Service<Identifier, Shape>,
): ServiceUse<Identifier, Shape> => {
  const cache = new Map<
    string,
    (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, unknown>
  >()
  return new Proxy(
    {},
    {
      get: (_, key: string) => {
        const cached = cache.get(key)
        if (cached) return cached
        const accessor = (...args: ReadonlyArray<unknown>) =>
          tag.use((service) => {
            const method = service[key as keyof Shape]
            if (typeof method !== "function")
              return Effect.die(new Error(`Service method not found: ${key}`))
            return (
              method as (
                ...a: ReadonlyArray<unknown>
              ) => Effect.Effect<unknown, unknown, unknown>
            )(...args)
          })
        cache.set(key, accessor)
        return accessor
      },
    },
  ) as ServiceUse<Identifier, Shape>
}

export * as ServiceUse from "./service-use"
