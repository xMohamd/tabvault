/**
 * Which backups a search covers. Pure: no extension APIs.
 *
 * A scope is either `null` (everything: every snapshot, and the loaded file if there is one, so a
 * backup made later is covered too) or an explicit set of source ids. At least one source always stays.
 */

/** Source id of the file loaded in the Import tab. */
export const FILE_SOURCE_ID = 'loaded-file';

export type Scope = ReadonlySet<string> | null;

/**
 * The chosen ids that still exist. `null` when that is every source, or when none of them is left
 * (a deleted backup, an unloaded file): the search then covers everything again.
 */
export function resolveScope(chosen: Scope, sourceIds: readonly string[]): Scope {
  if (!chosen) return null;
  const kept = new Set(sourceIds.filter((id) => chosen.has(id)));
  return kept.size === 0 || kept.size === sourceIds.length ? null : kept;
}

export const isInScope = (scope: Scope, id: string): boolean => scope === null || scope.has(id);

export const scopeSize = (scope: Scope, sourceIds: readonly string[]): number => (scope === null ? sourceIds.length : scope.size);

/** Ticks or unticks one source. Unticking the last remaining one is ignored. */
export function toggleSource(scope: Scope, sourceIds: readonly string[], id: string, on: boolean): Scope {
  const next = new Set(scope ?? sourceIds);
  if (on) next.add(id);
  else next.delete(id);
  return next.size === 0 ? scope : resolveScope(next, sourceIds);
}

/** "All backups": ticks everything; unticking it leaves just the first (newest) source. */
export function toggleAll(sourceIds: readonly string[], on: boolean): Scope {
  return on || sourceIds.length === 0 ? null : resolveScope(new Set(sourceIds.slice(0, 1)), sourceIds);
}
