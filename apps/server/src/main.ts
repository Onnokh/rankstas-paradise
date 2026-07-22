// Server entry point — STUB.
//
// The real HTTP server (Effect HttpApi over the domain services, bound to
// 0.0.0.0, bearer-gated; see PLO-276) replaces this. For now this only proves
// the app resolves against @rp/domain and boots. The golden test suite in
// ./test currently points at the legacy src/server.ts and will be repointed
// here once the real entry lands.
import { makeRuntime } from "@rp/domain/runtime"

const port = Number(Bun.env.SEO_PORT ?? 8790)

// Build the runtime so the composed root layer is exercised at startup. Every
// service method is currently an unimplemented die-stub.
const runtime = makeRuntime()
void runtime

console.log(
  `Ranksta's Paradise server (skeleton) — port ${port}. Not yet serving; real entry lands in PLO-276.`,
)
