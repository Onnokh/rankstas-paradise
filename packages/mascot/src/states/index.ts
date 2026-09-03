/**
 * The five states, one definition each. See `definition.ts` for what a state
 * is, and each file for why its state looks and moves the way it does.
 */

import type { MascotState } from "../types.ts";
import type { StateDefinition } from "./definition.ts";
import { error } from "./error.ts";
import { idle } from "./idle.ts";
import { loading } from "./loading.ts";
import { success } from "./success.ts";
import { thinking } from "./thinking.ts";

/**
 * The one list of states.
 *
 * `STATES` is read off these keys, so a state is added here and nowhere else.
 * Both ways that can go wrong are caught: a state left out of this record
 * fails `Record<MascotState, StateDefinition>` below, and a key that is not a
 * state fails the `readonly MascotState[]` on `STATES`.
 *
 * The order is the order — idle, thinking, loading, success, error — because
 * the playground lays its grid out in it.
 */
const DEFINITIONS = { idle, thinking, loading, success, error };

export const STATE: Record<MascotState, StateDefinition> = DEFINITIONS;

/**
 * Every state, in the record's own order.
 *
 * `Object.keys` is typed `string[]`, because an object may carry keys its type
 * does not name, so the result is narrowed to the record's own keys. That is
 * the only assertion here, and it claims nothing the object above does not
 * already say.
 */
export const STATES: readonly MascotState[] = Object.keys(DEFINITIONS) as (keyof typeof DEFINITIONS)[];

export type { Beat, Cycle, Gesture, LoopMotion, Performer, StateDefinition } from "./definition.ts";
export { CHANGE, NO_GESTURE } from "./definition.ts";
