// Catalog service: the stored list of sites and their settings, in the
// app-level SQLite database (see ../app-database). Process-global, like Sites:
// the catalog is the same for everyone. Sites reads it and resolves each entry
// into a Site; the server's settings routes write it.
//
// Each entry is stored as one JSON document (`ConfigSite`, validated on read)
// rather than one column per field, so adding a setting is a schema change in
// one place, not a table migration. A `catalog_meta` row records that the
// one-time import from a legacy config.json has run, so an emptied catalog is
// not silently refilled from the file.
import { Context, Effect, Layer, Schema } from "effect"
import { type SqlError } from "effect/unstable/sql"

import { AppDatabase } from "../app-database/app-database.ts"
import { ConfigSite, type SiteSettings } from "../config/schema.ts"
import { serviceUse } from "../service-use.ts"
import { SiteExistsError, UnknownSiteError } from "../sites/schema.ts"
import { CatalogError } from "./schema.ts"

export interface Interface {
  // Every stored entry, in the order they were added.
  readonly list: () => Effect.Effect<ReadonlyArray<ConfigSite>, CatalogError>
  // One entry by id.
  readonly get: (
    id: string,
  ) => Effect.Effect<ConfigSite, CatalogError | UnknownSiteError>
  // Store a new entry. The id must not be in use.
  readonly add: (
    site: ConfigSite,
  ) => Effect.Effect<void, CatalogError | SiteExistsError>
  // Replace the settings of an existing entry.
  readonly update: (
    site: ConfigSite,
  ) => Effect.Effect<void, CatalogError | UnknownSiteError>
  // Change some settings of an existing entry and leave the rest as stored.
  // Answers with the entry as it now reads, which saves the caller a re-read.
  //
  // The targeted counterpart of `update`, which replaces the whole document. A
  // caller that holds one setting would otherwise have to read the entry, merge
  // its own field in, and write the result back — and a caller that skipped the
  // read would silently drop the Site's analytics or revenue block. One field
  // is the common case for an agent, and losing a block it never mentioned is
  // the failure it cannot see.
  //
  // A key that is absent, or present and undefined, is left alone, so this
  // cannot clear a setting. `update` stays the way to do that.
  readonly patch: (
    id: string,
    changes: Partial<SiteSettings>,
  ) => Effect.Effect<ConfigSite, CatalogError | UnknownSiteError>
  // Remove an entry. The site's data directory on disk is left alone.
  readonly remove: (
    id: string,
  ) => Effect.Effect<void, CatalogError | UnknownSiteError>
  // The one-time import from a legacy config.json. Stores the entries and
  // records that the import ran; a later call does nothing and returns false,
  // whatever the catalog holds by then.
  readonly importOnce: (
    sites: ReadonlyArray<ConfigSite>,
  ) => Effect.Effect<boolean, CatalogError>
}

export class Service extends Context.Service<Service, Interface>()("@rp/Catalog") {}

export const use = serviceUse(Service)

const importedKey = "config_imported_at"

const decodeEntry = Schema.decodeUnknownEffect(ConfigSite)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { client: sql } = yield* AppDatabase.Service

    const catalogError =
      (operation: string) => (cause: SqlError.SqlError) =>
        new CatalogError({ message: `Catalog.${operation} failed`, cause })
    const mapErr =
      (operation: string) =>
      <A, E, R>(effect: Effect.Effect<A, E | SqlError.SqlError, R>) =>
        Effect.mapError(effect, (error) =>
          error instanceof CatalogError ||
          error instanceof UnknownSiteError ||
          error instanceof SiteExistsError
            ? error
            : catalogError(operation)(error as SqlError.SqlError),
        )

    const ddl = [
      `create table if not exists site (
        id text primary key,
        position integer not null,
        settings text not null,
        updated_at text not null default current_timestamp
      )`,
      `create table if not exists catalog_meta (
        key text primary key,
        value text not null
      )`,
    ]
    yield* Effect.forEach(ddl, (statement) => sql.unsafe(statement)).pipe(
      mapErr("initialize"),
    )

    // --- internal implementations (fail with SqlError; wrapped at the
    // boundary below). ---

    const parseRow = (row: { id: string; settings: string }) =>
      Effect.try({
        try: () => JSON.parse(row.settings) as unknown,
        catch: (cause) =>
          new CatalogError({
            message: `Catalog entry "${row.id}" is not valid JSON`,
            cause,
          }),
      }).pipe(
        Effect.flatMap((json) =>
          decodeEntry(json).pipe(
            Effect.mapError(
              (cause) =>
                new CatalogError({
                  message: `Catalog entry "${row.id}" does not match SiteSettings`,
                  cause,
                }),
            ),
          ),
        ),
      )

    const listI = Effect.gen(function* () {
      const rows = yield* sql<{ id: string; settings: string }>`
        select id, settings from site order by position, id`
      return yield* Effect.forEach(rows, parseRow)
    })

    const idsI = Effect.gen(function* () {
      const rows = yield* sql<{ id: string }>`select id from site order by position, id`
      return rows.map((row) => row.id)
    })

    const existsI = (id: string) =>
      Effect.map(
        sql<{ n: number }>`select count(*) as n from site where id = ${id}`,
        (rows) => (rows[0]?.n ?? 0) > 0,
      )

    const unknown = (id: string) =>
      Effect.flatMap(idsI, (available) =>
        Effect.fail(new UnknownSiteError({ siteId: id, available })),
      )

    const insertI = (site: ConfigSite) =>
      sql`insert into site (id, position, settings)
          values (
            ${site.id},
            (select coalesce(max(position), 0) + 1 from site),
            ${JSON.stringify(site)}
          )`

    const getI = (id: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string; settings: string }>`
          select id, settings from site where id = ${id}`
        const row = rows[0]
        if (!row) return yield* unknown(id)
        return yield* parseRow(row)
      })

    const addI = (site: ConfigSite) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (yield* existsI(site.id))
            return yield* Effect.fail(new SiteExistsError({ siteId: site.id }))
          yield* insertI(site)
        }),
      )

    const updateI = (site: ConfigSite) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* existsI(site.id))) return yield* unknown(site.id)
          yield* sql`update site
            set settings = ${JSON.stringify(site)}, updated_at = current_timestamp
            where id = ${site.id}`
        }),
      )

    const patchI = (id: string, changes: Partial<SiteSettings>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string; settings: string }>`
            select id, settings from site where id = ${id}`
          const row = rows[0]
          if (!row) return yield* unknown(id)
          const stored = yield* parseRow(row)
          // An undefined value is dropped rather than spread over the stored
          // one: `{ market: undefined }` from a caller that built its patch
          // object with optional fields must not clear the Market.
          const named = Object.fromEntries(
            Object.entries(changes).filter(([, value]) => value !== undefined),
          ) as Partial<SiteSettings>
          const patched: ConfigSite = { ...stored, ...named, id: stored.id }
          yield* sql`update site
            set settings = ${JSON.stringify(patched)}, updated_at = current_timestamp
            where id = ${id}`
          return patched
        }),
      )

    const removeI = (id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* existsI(id))) return yield* unknown(id)
          yield* sql`delete from site where id = ${id}`
        }),
      )

    const importOnceI = (sites: ReadonlyArray<ConfigSite>) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const done = yield* sql<{ value: string }>`
            select value from catalog_meta where key = ${importedKey}`
          if (done.length > 0) return false
          for (const site of sites) {
            if (!(yield* existsI(site.id))) yield* insertI(site)
          }
          yield* sql`insert into catalog_meta (key, value)
            values (${importedKey}, ${new Date().toISOString()})`
          return true
        }),
      )

    return {
      list: Effect.fn("Catalog.list")(() => listI.pipe(mapErr("list"))),
      get: Effect.fn("Catalog.get")((id) => getI(id).pipe(mapErr("get"))),
      add: Effect.fn("Catalog.add")((site) => addI(site).pipe(mapErr("add"))),
      update: Effect.fn("Catalog.update")((site) =>
        updateI(site).pipe(mapErr("update")),
      ),
      patch: Effect.fn("Catalog.patch")((id, changes) =>
        patchI(id, changes).pipe(mapErr("patch")),
      ),
      remove: Effect.fn("Catalog.remove")((id) => removeI(id).pipe(mapErr("remove"))),
      importOnce: Effect.fn("Catalog.importOnce")((sites) =>
        importOnceI(sites).pipe(mapErr("importOnce")),
      ),
    }
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(AppDatabase.defaultLayer))

export * as Catalog from "./catalog"
