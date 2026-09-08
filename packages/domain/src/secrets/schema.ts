// Frozen data shapes and errors for the Secrets domain: the vault of vendor
// keys (Polar, Rybbit, Ahrefs, …) stored encrypted in the app-level database.
//
// A secret is addressed by a scope and a purpose. The scope is a site id, or
// null for an app-wide key (Ahrefs rates every site with one account). The
// purpose is the provider name the key is for — the same string a site's
// analytics or revenue block names — so the server can hand the key to that
// provider's adapter under the environment variable it already reads.
import { Schema } from "effect"

// What is safe to say about a stored secret: where it applies, what it is for,
// its last four characters (blank for short values), and when it was written.
// Never the value.
export const SecretStatus = Schema.Struct({
  scope: Schema.NullOr(Schema.String),
  purpose: Schema.String,
  last4: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "SecretStatus" })
export interface SecretStatus extends Schema.Schema.Type<typeof SecretStatus> {}

// Whether this deployment can encrypt at all: it can when RP_MASTER_KEY is set
// and well-formed. `reason` says what is wrong when it cannot.
export const EncryptionStatus = Schema.Struct({
  configured: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
}).annotate({ identifier: "EncryptionStatus" })
export interface EncryptionStatus
  extends Schema.Schema.Type<typeof EncryptionStatus> {}

// The body of a write: the key itself, redacted the moment it is decoded so it
// cannot reach a log line.
export const SecretInput = Schema.Struct({
  value: Schema.Redacted(Schema.String),
}).annotate({ identifier: "SecretInput" })
export interface SecretInput extends Schema.Schema.Type<typeof SecretInput> {}

// Raised when the vault cannot be read or written, or a stored value cannot be
// decrypted with the current master key.
export class SecretsError extends Schema.TaggedErrorClass<SecretsError>()(
  "SecretsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Raised on a write when the deployment has no usable master key.
export class EncryptionUnavailableError extends Schema.TaggedErrorClass<EncryptionUnavailableError>()(
  "EncryptionUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message() {
    return `Secrets cannot be stored: ${this.reason}`
  }
}

// Raised when a purpose is not a safe name or a value is blank.
export class InvalidSecretError extends Schema.TaggedErrorClass<InvalidSecretError>()(
  "InvalidSecretError",
  {
    message: Schema.String,
  },
) {}

// Raised when a scope has no secret for the purpose.
export class UnknownSecretError extends Schema.TaggedErrorClass<UnknownSecretError>()(
  "UnknownSecretError",
  {
    scope: Schema.NullOr(Schema.String),
    purpose: Schema.String,
  },
) {
  override get message() {
    return `No "${this.purpose}" secret stored for ${this.scope === null ? "the app" : `site "${this.scope}"`}`
  }
}

export * as SecretsSchema from "./schema"
