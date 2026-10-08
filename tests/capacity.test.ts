import { describe, expect, it } from 'vitest';
import { recommendCapacity, resolveCapacityMode, type CapacityModeSignals, type CapacityObservation, type CapacitySettings } from '../src/capacity.js';
const counts = { 'application-worker': 1, 'ocr-worker': 1, 'extraction-worker': 1 };
const pressure: CapacityObservation = { backlog: 8, backlogAgeSeconds: 20, scheduleToStartP95Seconds: 8, activeActivities: 4, providerThrottles: 0 };
const settings: CapacitySettings = { mode: 'fixture', cpuBudget: 9, memoryBudgetMiB: 8192, providerConcurrencyQuota: null, extractionSlots: 4, fixedLimitsVerified: true };
describe('bounded local capacity recommendation', () => {
  it.each([
    [{ configuredMode: 'fixture', modelKeyConfigured: false, activeLiveApplications: 0 }, 'fixture'],
    [{ configuredMode: 'live', modelKeyConfigured: false, activeLiveApplications: 0 }, 'live'],
    [{ configuredMode: 'fixture', modelKeyConfigured: true, activeLiveApplications: 0 }, 'live'],
    [{ configuredMode: 'fixture', modelKeyConfigured: false, activeLiveApplications: 1 }, 'live'],
    [{ configuredMode: 'fixture', modelKeyConfigured: false, activeLiveApplications: null }, 'live'],
    [{ configuredMode: 'live', modelKeyConfigured: false, activeLiveApplications: null }, 'live'],
  ] satisfies [CapacityModeSignals, 'fixture' | 'live'][])('resolves workload quota mode from %j as %s', (signals, expected) => {
    expect(resolveCapacityMode(signals)).toBe(expected);
  });
  it('holds fixture-controller extraction growth for live work or unknown database mode until quota is explicit', () => {
    for (const activeLiveApplications of [1, null]) {
      const mode = resolveCapacityMode({ configuredMode: 'fixture', modelKeyConfigured: false, activeLiveApplications });
      const constrained = { ...settings, mode };
      expect(recommendCapacity('extraction-worker', counts, pressure, constrained, { high: 2, idle: 0 }))
        .toMatchObject({ action: 'HOLD', targetReplicas: 1 });
      expect(recommendCapacity('extraction-worker', counts, pressure,
        { ...constrained, providerConcurrencyQuota: 8 }, { high: 2, idle: 0 }))
        .toMatchObject({ action: 'GROW', targetReplicas: 2 });
    }
  });
  it('treats malformed live-work counts as unknown instead of confirming fixture-only work', () => {
    for (const activeLiveApplications of [NaN, Infinity, -1, 0.5]) {
      expect(resolveCapacityMode({ configuredMode: 'fixture', modelKeyConfigured: false, activeLiveApplications })).toBe('live');
    }
  });
  it('requires sustained latency pressure, fixed resources and resource budget headroom', () => {
    expect(recommendCapacity('ocr-worker', counts, pressure, settings).action).toBe('HOLD');
    expect(recommendCapacity('ocr-worker', counts, pressure, settings, { high: 1, idle: 0 })).toMatchObject({ action: 'GROW', targetReplicas: 2 });
    expect(recommendCapacity('ocr-worker', counts, pressure, { ...settings, cpuBudget: 3 }, { high: 1, idle: 0 }).action).toBe('HOLD');
    expect(recommendCapacity('ocr-worker', counts, pressure, { ...settings, fixedLimitsVerified: false }, { high: 1, idle: 0 }).action).toBe('HOLD');
  });
  it('holds live extraction when quota is unknown, exhausted, or provider throttles', () => {
    const trend = { high: 2, idle: 0 };
    expect(recommendCapacity('extraction-worker', counts, pressure, { ...settings, mode: 'live' }, trend).action).toBe('HOLD');
    expect(recommendCapacity('extraction-worker', counts, pressure, { ...settings, mode: 'live', providerConcurrencyQuota: 4 }, trend).action).toBe('HOLD');
    expect(recommendCapacity('extraction-worker', counts, { ...pressure, providerThrottles: 1 }, { ...settings, mode: 'live', providerConcurrencyQuota: 12 }, trend).action).toBe('HOLD');
  });
  it('uses three idle observations, respects 1–3 bounds, and never treats missing stats as idle', () => {
    const idle = { ...pressure, backlog: 0, backlogAgeSeconds: 0, scheduleToStartP95Seconds: 0, activeActivities: 0 };
    expect(recommendCapacity('ocr-worker', { ...counts, 'ocr-worker': 2 }, idle, settings, { high: 0, idle: 2 })).toMatchObject({ action: 'SHRINK', targetReplicas: 1 });
    expect(recommendCapacity('ocr-worker', { ...counts, 'ocr-worker': 3 }, pressure, settings, { high: 2, idle: 0 }).action).toBe('HOLD');
    expect(recommendCapacity('ocr-worker', counts, { ...idle, backlog: null }, settings, { high: 0, idle: 2 }).action).toBe('HOLD');
  });
});
