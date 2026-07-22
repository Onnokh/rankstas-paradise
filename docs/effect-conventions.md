# Effect v4 conventions (Ranksta's Paradise)

This is the contract every package in the monorepo follows. It ports the shared
Effect-patterns **module contract** and pins the **Effect v4-beta API map** that
this repo was built and verified against. Read it before adding or changing a
service.

> **Effect v4-beta only.** Training data and most online examples are v3, whose
> API differs (`Effect.catchAll` vs v4's replacement, `Schema.TaggedError` vs
> `Schema.TaggedErrorClass`, `Config.String` vs `Config.string`, …). When an API
> question isn't answered here, check the pinned `effect` source in
> `node_modules/effect/dist/*.d.ts` **before** guessing.

## Pinned versions (exact, lockstep)

`effect`, `@effect/platform-bun`, and `@effect/sql-sqlite-bun` are all pinned to
**`4.0.0-beta.99`** (exact — no `^`, no `latest`) at the workspace root, so the
whole workspace resolves one version. Runtime is **Bun 1.3.x**.

## The module contract

Every service module is one file with exports in one fixed order:

```ts
// packages/domain/src/sites/sites.ts
import { Context, Effect, Layer } from "effect"
import { serviceUse } from "../service-use.ts"

export interface Interface {
  readonly loadSites: () => Effect.Effect<ReadonlyArray<Site>>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Sites") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service // deps pulled by type
    return { loadSites: () => Effect.succeed(/* ... */) }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Config.defaultLayer))

export * as Sites from "./sites"
```

**Fixed order:** `Interface` → `Service` → `use` → `layer` → `defaultLayer` →
self-reexport. Keep it identical in every module.

Rules:

- **Service tag string:** `"@rp/PascalName"`, unique and mechanical. Never reuse.
- **No `export namespace`** — it breaks tree-shaking and Node/Bun type-stripping.
  Use flat exports + the self-reexport (`export * as X from "./x"`).
- **No barrel `index.ts`** — import the specific file
  (`import { Sites } from "@rp/domain/sites/sites"`).
- **`schema.ts` per domain** holds branded IDs, data shapes, and error classes;
  the service file imports them. Superseded wire/storage formats live in a
  parallel versioned file (e.g. `schema.v1.ts`), not migration code.
- **Errors are `Schema.TaggedErrorClass`** so they flow through the typed error
  channel and narrow under `catchTag`.
- **`Effect.fn("Service.method")`** for traced public methods (real impls);
  `Effect.fnUntraced` for internal helpers.
- The `serviceUse` accessor (`packages/domain/src/service-use.ts`) lets consumers
  call `Sites.use.loadSites()` instead of `yield* Sites.Service` then the method.

## Services, layers, runtime

- Declare dependencies by `yield*`-ing another service's tag inside a layer.
- `defaultLayer` = "the layer with everything it needs already wired"
  (`layer.pipe(Layer.provide(Dep.defaultLayer))`).
- One root layer composes every service's `defaultLayer`
  (`packages/domain/src/runtime.ts`), and `ManagedRuntime.make(AppLayer)` turns it
  into something you can `runPromise` against. Build the runtime once and reuse it.
- **`CurrentSite`** is the per-scope active site (it replaces the legacy
  `withSite(...)` `node:async_hooks` thread-local). Site-scoped services
  (`Storage`, `Registry`, `Sitemap`, `Reports`, `Sync`, and the site-scoped parts
  of `SearchConsole`) depend on `CurrentSite` — they never take a site parameter.
  Its `defaultLayer` in the skeleton is a die stub; a real per-scope layer supplies
  the resolved `Site` at the request/CLI boundary.
- **No `AsyncLocalStorage`** in `packages/` or `apps/`.

## The verified v4-beta API map

Trust this over training data. Confirmed working on Bun 1.3.10:

Top-level barrel `import { ... } from "effect"` has:
`Effect, Context, Layer, Schema, Config, Cache, Semaphore, ManagedRuntime,
Redacted, Data, Option, Exit, Cause, Duration, Schedule, Ref, Stream`, …

- **Service tag:** `class Foo extends Context.Service<Foo, Interface>()("@rp/Foo") {}`
  — `Context.Service` (NOT `Effect.Service`). The class exposes `.use(f)`,
  `.useSync(f)`, `.of(shape)`, `.context(shape)`.
- **Errors:** `class E extends Schema.TaggedErrorClass<E>()("E", { message: Schema.String, cause: Schema.optional(Schema.Defect()) }) {}`
  (NOT `Schema.TaggedError` — undefined in v4).
- **Schema:** `Schema.Struct`, `Schema.Array`, `Schema.String/Number/Boolean`,
  `Schema.Literal(x)`, `Schema.Literals([...])`, `Schema.Union([...])`,
  `Schema.NullOr(s)`, `Schema.optional(s)`, `Schema.Record(k, v)`,
  `Schema.Unknown`, `Schema.Redacted(s)`, `Schema.Defect()`,
  `Schema.brand("Id")`. Derive types with `Schema.Schema.Type<typeof S>`;
  read struct fields via `S.fields`. `.annotate({ identifier: "..." })`.
- **Config recipes are lowercase functions:** `Config.string(name)`,
  `Config.number`, `Config.boolean`, `Config.redacted(name)` (→ `Redacted<string>`),
  `Config.nonEmptyString`, `Config.url`, `Config.port`, `Config.all(...)`,
  `Config.withDefault`, `Config.option`, `Config.nested`. (NOT `Config.String`.)
- **Layer:** `Layer.effect`, `Layer.sync`, `Layer.succeed`, `Layer.effectContext`,
  `Layer.mergeAll`, `Layer.provide`, `Layer.provideMerge`, `Layer.suspend`.
- **Runtime:** `ManagedRuntime.make(layer)` → `.runPromise` / `.runPromiseExit`.
- **HTTP / SQL live under subpath exports, NOT the barrel:**
  - `effect/unstable/httpapi` → `HttpApi, HttpApiGroup, HttpApiEndpoint,
    HttpApiBuilder, HttpApiClient, HttpApiMiddleware, HttpApiSecurity,
    HttpApiSchema, HttpApiError, HttpApiScalar, HttpApiSwagger, OpenApi`
  - `effect/unstable/http` → `HttpClient, HttpServer, FetchHttpClient,
    HttpClientRequest, HttpClientResponse, HttpServerResponse, HttpRouter,
    HttpMiddleware, Headers, UrlParams, ...`
  - `effect/unstable/sql` → `SqlClient, SqlError, Statement, Migrator, SqlSchema, ...`
  - `@effect/platform-bun` → `BunHttpServer, BunHttpClient, BunRuntime,
    BunFileSystem, ...`
  - `@effect/sql-sqlite-bun` → `SqliteClient, SqliteMigrator`

### Beta surprises hit while building the skeleton

- `Effect.catchAll` (v3) is **gone** in beta.99 — the legacy v3 `src/` therefore
  cannot run under the pinned v4. The golden suite runs the legacy baseline in an
  isolated temp workspace pinned to `effect@3.22.0` (see
  `apps/server/test/lib/harness.ts`).
- `Config.*` constructors are **lowercase** (`Config.string`, not `Config.String`).
- `Context.Service` is present on the barrel but resolving `effect` from a file
  with no local `node_modules` (e.g. `/tmp`) auto-installs v3 — always run probes
  inside the workspace.

## TypeScript build

Project references + `tsc --build`. `tsconfig.base.json` uses
`allowImportingTsExtensions` + `composite` + `emitDeclarationOnly` (required
together). Each package extends the base, sets `outDir`/`rootDir` and its
`references`; the root `tsconfig.json` is a solution file (`files: []` +
`references` to every package). Reference graph:
`domain → (none)`, `api-client → domain`, `server → domain`, `tui → api-client`.
Run `bun run check` (= `tsc --build`) from the repo root.
