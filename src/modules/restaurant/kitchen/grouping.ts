/**
 * One kitchen ticket per station, so each section (kitchen, bar, ...) owns
 * its own queue. Extracted from `fireOrder` so the split itself — "does a
 * mixed order produce exactly one ticket per distinct station, with no item
 * duplicated and none dropped" — is verifiable without a database.
 */
export function groupItemsByStation<T extends { station_id: string | null }>(
  items: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.station_id ?? "unassigned";
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}
