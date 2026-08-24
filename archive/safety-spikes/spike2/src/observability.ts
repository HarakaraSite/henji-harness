export interface AdmissionCountersV1 {
  clock: number;
  broker: number;
  builderProcess: number;
  publish: number;
  register: number;
  currentWrite: number;
  deploymentStateWrite: number;
}

export const createAdmissionCounters = (): AdmissionCountersV1 => ({
  clock: 0,
  broker: 0,
  builderProcess: 0,
  publish: 0,
  register: 0,
  currentWrite: 0,
  deploymentStateWrite: 0,
});
