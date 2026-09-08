// Frozen data shapes and errors for the Clients domain: the bearer tokens the
// server issues to individual clients (a Mac, a TUI, an agent), so each holds
// its own credential and any one can be revoked without touching the rest.
import { Schema } from "effect"

// What is known about one client. The token itself is never stored or shown
// again after creation; only its hash is kept.
export const Client = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  createdAt: Schema.String,
  // When the token was last accepted, to the minute; null until first use.
  lastUsedAt: Schema.NullOr(Schema.String),
  // Set when the token was revoked. A revoked client is kept for the record.
  revokedAt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Client" })
export interface Client extends Schema.Schema.Type<typeof Client> {}

// The body of a create: a label naming the client ("Onno's MacBook").
export const ClientInput = Schema.Struct({
  label: Schema.String,
}).annotate({ identifier: "ClientInput" })
export interface ClientInput extends Schema.Schema.Type<typeof ClientInput> {}

// Raised when the client table cannot be read or written.
export class ClientsError extends Schema.TaggedErrorClass<ClientsError>()(
  "ClientsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

// Raised when a label is blank.
export class InvalidClientError extends Schema.TaggedErrorClass<InvalidClientError>()(
  "InvalidClientError",
  {
    message: Schema.String,
  },
) {}

// Raised when no client has the id.
export class UnknownClientError extends Schema.TaggedErrorClass<UnknownClientError>()(
  "UnknownClientError",
  {
    clientId: Schema.String,
  },
) {
  override get message() {
    return `Unknown client "${this.clientId}"`
  }
}

export * as ClientsSchema from "./schema"
