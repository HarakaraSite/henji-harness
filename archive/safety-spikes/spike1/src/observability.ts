export interface RevisionCounters {
  ticketLookup: number;
  merge: number;
  hash: number;
  id: number;
  clock: number;
  artifact: number;
  admission: number;
  registryWrite: number;
  currentWrite: number;
  process: number;
  broker: number;
}
export const newCounters = (): RevisionCounters => ({
  ticketLookup: 0,
  merge: 0,
  hash: 0,
  id: 0,
  clock: 0,
  artifact: 0,
  admission: 0,
  registryWrite: 0,
  currentWrite: 0,
  process: 0,
  broker: 0,
});
