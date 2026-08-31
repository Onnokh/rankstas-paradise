// DomainRating service: the site's Ahrefs Domain Rating, cached on the volume.
//
// Shaped like Sitemap deliberately. `refresh` reaches the network and is called
// by Sync; `cached` only reads the file and is what the dashboard read uses. A
// dashboard must never block on Ahrefs — if it did, a slow third party would
// stall a screen whose other numbers are already on disk.
//
// The whole feature is optional. With no API key configured, `refresh` is a
// no-op and `cached` yields null, and every caller renders a site without a
// rating rather than an error.
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import { Config as EffectConfig, Context, Effect, Layer, Option, Redacted } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"

import { CurrentSite } from "../sites/current-site.ts"
import { serviceUse } from "../service-use.ts"
import { DomainRatingError, type DomainRating } from "./schema.ts"

export interface Interface {
  // The stored reading, or null when the site has none. Never fails and never
  // reaches the network — this is what report reads call.
  readonly cached: () => Effect.Effect<DomainRating | null>
  // Ask Ahrefs and store the answer. Returns null when no API key is
  // configured, so an unconfigured deployment simply has no rating.
  readonly refresh: () => Effect.Effect<DomainRating | null, DomainRatingError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rp/DomainRating",
) {}

export const use = serviceUse(Service)

// Ahrefs' free Domain Rating endpoint. Every plan may call it, and it needs only
// the target and a bearer key.
// https://docs.ahrefs.com/en/api/reference/public/get-domain-rating-free
const ENDPOINT = "https://api.ahrefs.com/v3/public/domain-rating-free"

// A third party must not be able to hold a sync open indefinitely.
const TIMEOUT_MS = 10_000

// Ahrefs answers `{ domain_rating: { domain_rating, license } }` — the nesting
// and the repeated key are theirs, not a typo here.
interface AhrefsResponse {
  readonly domain_rating?: {
    readonly domain_rating?: number
    readonly license?: string
  }
}

// Ahrefs wants a bare host. A site's `origin` is a full URL, so it is reduced
// rather than passed through — "https://www.printfeest.nl" asks about the same
// site as "www.printfeest.nl", but the URL form is not what their examples use.
const hostOf = (origin: string): string | null => {
  try {
    return new URL(origin).hostname
  } catch {
    return null
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const currentSite = yield* CurrentSite.Service
    const httpClient = yield* HttpClient.HttpClient

    // Redacted so the key cannot reach a log line or an error message. Absent by
    // design on a deployment that has not configured Ahrefs.
    const apiKey = yield* EffectConfig.redacted("AHREFS_API_KEY").pipe(
      EffectConfig.option,
    )

    // Beside the site's other cached third-party read (sitemap.json), on the
    // persistent volume rather than in memory, so a restart does not cost a
    // request against the account's quota.
    const cachePath = Effect.fn("DomainRating.cachePath")(function* () {
      const directory = yield* currentSite.dataDirectory()
      return `${directory}/domain-rating.json`
    })

    const impl: Interface = {
      cached: () =>
        Effect.gen(function* () {
          const path = yield* cachePath()
          // A missing or malformed cache is not an error; it is a site with no
          // reading yet, which every caller already renders.
          return yield* Effect.promise(async () => {
            const file = Bun.file(path)
            if (!(await file.exists())) return null
            try {
              const parsed = JSON.parse(await file.text()) as DomainRating
              return typeof parsed?.rating === "number" ? parsed : null
            } catch {
              return null
            }
          })
        }),

      refresh: Effect.fn("DomainRating.refresh")(function* () {
        // A blank value counts as absent. `AHREFS_API_KEY=` set to nothing is a
        // configured-but-empty key, which would otherwise sail past this guard
        // and come back as an Ahrefs 401 — an error, where the honest answer is
        // simply that no key is configured.
        if (Option.isNone(apiKey) || Redacted.value(apiKey.value).trim() === "")
          return null

        const site = yield* currentSite.current()
        const target = hostOf(site.origin)
        if (!target) return null

        const url = `${ENDPOINT}?target=${encodeURIComponent(target)}`
        const response = yield* httpClient
          .execute(
            HttpClientRequest.get(url).pipe(
              HttpClientRequest.setHeader(
                "authorization",
                `Bearer ${Redacted.value(apiKey.value)}`,
              ),
              HttpClientRequest.setHeader("accept", "application/json"),
            ),
          )
          .pipe(
            Effect.timeoutOrElse({
              duration: `${TIMEOUT_MS} millis`,
              orElse: () =>
                Effect.fail(
                  new DomainRatingError({
                    message: `Ahrefs did not answer within ${TIMEOUT_MS / 1000}s.`,
                  }),
                ),
            }),
            Effect.mapError((cause) =>
              cause instanceof DomainRatingError
                ? cause
                : new DomainRatingError({
                    message: `Could not reach Ahrefs: ${String(cause)}`,
                    cause,
                  }),
            ),
          )

        // `execute` does not fail on non-2xx, so the status is classified here.
        // 401/403 means the key is wrong and 429 means the quota is spent; both
        // are worth naming, because a silent null would look like "no data".
        if (response.status < 200 || response.status >= 300)
          return yield* Effect.fail(
            new DomainRatingError({
              message:
                response.status === 401 || response.status === 403
                  ? "Ahrefs rejected the API key (HTTP " + response.status + ")."
                  : response.status === 429
                    ? "Ahrefs rate-limited the request (HTTP 429)."
                    : `Ahrefs request failed with HTTP ${response.status}.`,
            }),
          )

        const body = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new DomainRatingError({
                message: "Could not read the Ahrefs response.",
                cause,
              }),
          ),
        )
        const rating = (body as AhrefsResponse)?.domain_rating?.domain_rating
        if (typeof rating !== "number" || !Number.isFinite(rating))
          return yield* Effect.fail(
            new DomainRatingError({
              message: "Ahrefs returned no domain_rating for this target.",
            }),
          )

        const reading: DomainRating = {
          target,
          rating,
          fetchedAt: new Date().toISOString(),
          // Ahrefs requires the licence to travel with the number; if they stop
          // sending it, the canonical URL stands in rather than an empty string.
          license:
            (body as AhrefsResponse).domain_rating?.license ??
            "https://ahrefs.com/legal/domain-rating-license",
        }

        const path = yield* cachePath()
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(dirname(path), { recursive: true })
            await Bun.write(path, `${JSON.stringify(reading, null, 2)}\n`)
          },
          catch: (cause) =>
            new DomainRatingError({
              message: "Could not cache the domain rating.",
              cause,
            }),
        })
        return reading
      }),
    }

    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(CurrentSite.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export * as DomainRating from "./domain-rating"
