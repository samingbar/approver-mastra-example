export const workerServices = ['application-worker', 'ocr-worker', 'extraction-worker'] as const;
export type WorkerService = typeof workerServices[number];
export const workerLimits: Record<WorkerService, { cpu: number; memoryMiB: number }> = {
  'application-worker': { cpu: 1, memoryMiB: 768 },
  'ocr-worker': { cpu: 1, memoryMiB: 1024 },
  'extraction-worker': { cpu: 1, memoryMiB: 768 },
};
export interface CapacityObservation {
  backlog: number | null; backlogAgeSeconds: number | null; scheduleToStartP95Seconds: number | null;
  activeActivities: number | null; providerThrottles: number;
}
export interface CapacitySettings {
  mode: 'fixture' | 'live'; cpuBudget: number; memoryBudgetMiB: number; providerConcurrencyQuota: number | null;
  extractionSlots: number; fixedLimitsVerified: boolean;
}
export interface CapacityTrend { high: number; idle: number }

export interface CapacityModeSignals {
  configuredMode: 'fixture' | 'live'; modelKeyConfigured: boolean;
  /** Null means the active-work mode observation was unavailable or malformed. */
  activeLiveApplications: number | null;
}

/** A fixture controller can still observe live work started by a separate API. */
export function resolveCapacityMode(signals: CapacityModeSignals): 'fixture' | 'live' {
  const { configuredMode, modelKeyConfigured, activeLiveApplications } = signals;
  if (configuredMode === 'live' || modelKeyConfigured || activeLiveApplications === null
      || !Number.isSafeInteger(activeLiveApplications) || activeLiveApplications < 0 || activeLiveApplications > 0) {
    return 'live';
  }
  return 'fixture';
}

/** Teaching thresholds: two pressured observations to grow; three empty observations to shrink. */
export function recommendCapacity(
  service: WorkerService, current: Record<WorkerService, number | null>, observation: CapacityObservation,
  settings: CapacitySettings, previous: CapacityTrend = { high: 0, idle: 0 },
) {
  const pressure = (observation.backlogAgeSeconds ?? 0) >= 15 || (observation.scheduleToStartP95Seconds ?? 0) >= 5;
  const empty = observation.backlog === 0 && observation.activeActivities === 0 && (observation.scheduleToStartP95Seconds ?? Infinity) < 1;
  const trend = { high: pressure ? previous.high + 1 : 0, idle: empty ? previous.idle + 1 : 0 };
  const replicas = current[service];
  const hold = (reason: string) => ({ service, currentReplicas: replicas, targetReplicas: replicas, action: 'HOLD' as const, reason, trend });
  if (replicas === null || Object.values(current).some((count) => count === null)) return hold('Existing Compose worker replica counts are unavailable.');
  if (!settings.fixedLimitsVerified) return hold('Fixed Compose worker CPU/memory limits have not been verified.');
  if (observation.backlog === null || observation.backlogAgeSeconds === null) return hold('Temporal queue statistics are unavailable.');
  if (service === 'extraction-worker' && settings.mode === 'live' && settings.providerConcurrencyQuota === null) return hold('Live provider concurrency quota is not configured; never infer it from CPU.');
  if (service === 'extraction-worker' && observation.providerThrottles > 0) return hold('Recent observed provider throttling requires operator/quota review.');
  let target = replicas;
  if (trend.high >= 2) target = Math.min(3, replicas + 1);
  else if (trend.idle >= 3) target = Math.max(1, replicas - 1);
  if (target === replicas) return hold(pressure ? 'Waiting for two sustained pressure observations or already at the three-replica cap.' : 'Waiting for three idle observations or already at the one-replica floor.');
  if (target > replicas && service === 'extraction-worker' && settings.providerConcurrencyQuota !== null && target * settings.extractionSlots > settings.providerConcurrencyQuota) return hold('The proposed extraction slots exceed the configured provider concurrency quota.');
  const proposed = { ...current, [service]: target };
  const cpu = workerServices.reduce((sum, name) => sum + proposed[name]! * workerLimits[name].cpu, 0);
  const memory = workerServices.reduce((sum, name) => sum + proposed[name]! * workerLimits[name].memoryMiB, 0);
  if (target > replicas && (cpu > settings.cpuBudget || memory > settings.memoryBudgetMiB)) return hold('The proposed workers exceed the configured shared worker CPU/memory budget.');
  return { service, currentReplicas: replicas, targetReplicas: target, action: target > replicas ? 'GROW' as const : 'SHRINK' as const,
    reason: target > replicas ? 'Sustained queue age/dispatch latency and resource/quota headroom.' : 'Three empty observations with zero observed active activities.', trend };
}
