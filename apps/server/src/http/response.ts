// Response builders that reproduce the legacy HTTP contract byte-for-byte:
// JSON bodies are the `{ generatedAt, mode, ...payload }` envelope, pretty
// -printed with two-space indentation and served as `application/json`; text
// feeds are served verbatim as `text/plain`. Ported from the legacy `json()` /
// text helpers in `src/server.ts`.
import { HttpServerResponse } from "effect/unstable/http"

// The mode flag both frontends key off: "debug" for the isolated fake database,
// "live" for the real Search Console data.
export const modeOf = (debug: boolean): "debug" | "live" => (debug ? "debug" : "live")

// `{ generatedAt, mode, ...payload }`, pretty-printed 2-space — identical bytes
// to the legacy `json()` helper.
export const jsonEnvelope = (
  payload: object,
  debug: boolean,
  status = 200,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(
    JSON.stringify(
      { generatedAt: new Date().toISOString(), mode: modeOf(debug), ...payload },
      null,
      2,
    ),
    { status, contentType: "application/json" },
  )

// An `{ error }` envelope at a chosen status (400/401/409/503).
export const errorEnvelope = (
  message: string,
  debug: boolean,
  status: number,
): HttpServerResponse.HttpServerResponse => jsonEnvelope({ error: message }, debug, status)

// A plain-text feed body (the Native SDK / TUI text surfaces).
export const plainText = (body: string): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.text(body, { contentType: "text/plain" })
