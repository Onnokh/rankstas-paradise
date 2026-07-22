// The single interop edge between the imperative opentui render loop / CLI and
// the Effect-based api-client. `ApiClient.defaultLayer` wires the platform fetch
// transport and resolves the remote target ({ apiUrl, token }) from
// RP_API_URL/RP_TOKEN (or client.json) — so a missing config fails the very
// first `runApi` call, which is how the TUI/CLI enforce "remote client only".
//
// The runtime is built once and reused; every api-client method is an Effect run
// through `runApi` at the boundary (the render loop stays synchronous and reads
// from the pre-loaded snapshot, never from an Effect).
import { Effect, ManagedRuntime } from "effect"

import { ApiClient } from "@rp/api-client/client"

export const runtime = ManagedRuntime.make(ApiClient.defaultLayer)

// Run an api-client Effect to a Promise. The runtime already provides
// `ApiClient.Service` (and its transport/config deps), so callers only ever
// carry that one requirement.
export const runApi = <A, E>(
  effect: Effect.Effect<A, E, ApiClient.Service>,
): Promise<A> => runtime.runPromise(effect)
