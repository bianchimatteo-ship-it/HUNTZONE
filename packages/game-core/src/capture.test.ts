import { describe, expect, it } from 'vitest';
import { applyPinAttempt, evaluateCaptureEvidence, evaluatePinCaptureAttempt, validateCapturePolicy, type CapturePolicy, type LocationObservation } from './capture';

const radius: CapturePolicy = {
  method: 'radius', distanceMeters: 30, maxAccuracyMeters: 12, maxSampleAgeSeconds: 15,
};
const near: LocationObservation = { latitude: 45, longitude: 9, accuracyMeters: 3, observedAtMs: 10_000, sequence: 1 };
const nearby: LocationObservation = { ...near, longitude: 9.00001, sequence: 2 };

describe('capture policy validation', () => {
  it('accepts each explicitly parameterized policy without choosing defaults', () => {
    expect(validateCapturePolicy(radius).ok).toBe(true);
    expect(validateCapturePolicy({ ...radius, method: 'pin', pin: { expiresAfterSeconds: 60, maxAttempts: 4, invalidateAfterUse: true } }).ok).toBe(true);
    expect(validateCapturePolicy({ ...radius, method: 'automatic', automatic: { minimumProximitySeconds: 8 } }).ok).toBe(true);
  });

  it('requires GPS policy and PIN protections together', () => {
    const missingGps = validateCapturePolicy({ method: 'pin', pin: { expiresAfterSeconds: 60, maxAttempts: 4, invalidateAfterUse: true } });
    expect(missingGps.ok).toBe(false);
    if (!missingGps.ok) expect(missingGps.error.fields).toContain('distanceMeters');
    expect(validateCapturePolicy({ ...radius, method: 'pin', pin: { expiresAfterSeconds: 60, maxAttempts: 4, invalidateAfterUse: false } }).ok).toBe(false);
    expect(validateCapturePolicy({ ...radius, method: 'automatic', automatic: { minimumProximitySeconds: 8 }, pin: { expiresAfterSeconds: 60, maxAttempts: 4, invalidateAfterUse: true } }).ok).toBe(false);
  });

  it('rejects unknown fields and unbounded or non-positive parameters', () => {
    expect(validateCapturePolicy({ ...radius, arbitrary: true }).ok).toBe(false);
    expect(validateCapturePolicy({ ...radius, maxSampleAgeSeconds: 0 }).ok).toBe(false);
    expect(validateCapturePolicy({ ...radius, distanceMeters: Infinity }).ok).toBe(false);
    expect(validateCapturePolicy({ ...radius, distanceMeters: 3000.1 }).ok).toBe(false);
    expect(validateCapturePolicy({ ...radius, maxSampleAgeSeconds: 3601 }).ok).toBe(false);
    expect(validateCapturePolicy({ ...radius, method: 'pin', pin: { expiresAfterSeconds: 60, maxAttempts: 11, invalidateAfterUse: true } }).ok).toBe(false);
  });
});

describe('server-held capture evidence evaluation', () => {
  it('accepts fresh, accurate samples inside the conservative threshold', () => {
    expect(evaluateCaptureEvidence({ policy: radius, captor: near, target: nearby, nowMs: 11_000, lastAcceptedSequence: { captor: 0, target: 1 } }).status).toBe('eligible');
  });

  it('returns indeterminate for missing, malformed, future, stale, inaccurate, or out-of-range samples', () => {
    const seq = { captor: 0, target: 1 };
    expect(evaluateCaptureEvidence({ policy: radius, nowMs: 11_000, lastAcceptedSequence: seq }).reason).toBe('missing-sample');
    expect(evaluateCaptureEvidence({ policy: radius, captor: { ...near, latitude: 100 }, target: nearby, nowMs: 11_000, lastAcceptedSequence: seq }).reason).toBe('invalid-sample');
    expect(evaluateCaptureEvidence({ policy: radius, captor: { ...near, observedAtMs: 12_000 }, target: nearby, nowMs: 11_000, lastAcceptedSequence: seq }).reason).toBe('future-sample');
    expect(evaluateCaptureEvidence({ policy: radius, captor: { ...near, observedAtMs: 0 }, target: nearby, nowMs: 20_000, lastAcceptedSequence: seq }).reason).toBe('stale-sample');
    expect(evaluateCaptureEvidence({ policy: radius, captor: near, target: nearby, nowMs: 11_000, lastAcceptedSequence: { captor: 1, target: 1 } }).reason).toBe('out-of-sequence');
    expect(evaluateCaptureEvidence({ policy: radius, captor: { ...near, accuracyMeters: 13 }, target: nearby, nowMs: 11_000, lastAcceptedSequence: seq }).reason).toBe('poor-accuracy');
    expect(evaluateCaptureEvidence({ policy: radius, captor: near, target: { ...nearby, longitude: 9.001 }, nowMs: 11_000, lastAcceptedSequence: seq }).reason).toBe('outside-range');
  });

  it('requires the configured dwell interval for automatic capture', () => {
    const policy: CapturePolicy = { ...radius, method: 'automatic', automatic: { minimumProximitySeconds: 8 } };
    const seq = { captor: 0, target: 1 };
    expect(evaluateCaptureEvidence({ policy, captor: near, target: nearby, nowMs: 11_000, lastAcceptedSequence: seq }).reason).toBe('dwell-incomplete');
    expect(evaluateCaptureEvidence({ policy, captor: near, target: nearby, nowMs: 18_000, lastAcceptedSequence: seq, proximityStartedAtMs: 11_000 }).reason).toBe('dwell-incomplete');
    expect(evaluateCaptureEvidence({ policy, captor: near, target: nearby, nowMs: 19_000, lastAcceptedSequence: seq, proximityStartedAtMs: 11_000 }).status).toBe('eligible');
  });

  it('does not decide a capture outcome or return coordinates', () => {
    const result = evaluateCaptureEvidence({ policy: radius, captor: near, target: nearby, nowMs: 11_000, lastAcceptedSequence: { captor: 0, target: 1 } });
    expect(result).not.toHaveProperty('captured');
    expect(result).not.toHaveProperty('latitude');
    expect(result).not.toHaveProperty('longitude');
  });
});

describe('temporary PIN attempt gate', () => {
  const policy = { expiresAfterSeconds: 120, maxAttempts: 3, invalidateAfterUse: true as const };
  it('limits failures, expires credentials, and invalidates a successful use', () => {
    const initial = { expiresAtMs: 20_000, attemptsRemaining: 3, consumed: false };
    const wrong1 = applyPinAttempt({ policy, state: initial, nowMs: 10_000, matches: false });
    const wrong2 = applyPinAttempt({ policy, state: wrong1.state, nowMs: 10_100, matches: false });
    const wrong3 = applyPinAttempt({ policy, state: wrong2.state, nowMs: 10_200, matches: false });
    expect(wrong3.reason).toBe('locked');
    expect(applyPinAttempt({ policy, state: wrong3.state, nowMs: 10_300, matches: true }).reason).toBe('locked');
    const accepted = applyPinAttempt({ policy, state: initial, nowMs: 10_000, matches: true });
    expect(accepted.accepted).toBe(true);
    expect(applyPinAttempt({ policy, state: accepted.state, nowMs: 10_100, matches: true }).reason).toBe('already-used');
    expect(applyPinAttempt({ policy, state: initial, nowMs: 20_000, matches: true }).reason).toBe('expired');
  });

  it('requires eligible GPS evidence before consuming or counting a PIN attempt', () => {
    const pinPolicy: CapturePolicy = { ...radius, method: 'pin', pin: policy };
    const state = { expiresAtMs: 20_000, attemptsRemaining: 3, consumed: false };
    const uncertain = evaluatePinCaptureAttempt({ policy: pinPolicy, state, nowMs: 11_000, matches: true, lastAcceptedSequence: { captor: 0, target: 1 } });
    expect(uncertain.accepted).toBe(false);
    expect(uncertain.state).toEqual(state);
    const eligible = evaluatePinCaptureAttempt({ policy: pinPolicy, state, nowMs: 11_000, matches: true, captor: near, target: nearby, lastAcceptedSequence: { captor: 0, target: 1 } });
    expect(eligible.accepted).toBe(true);
    expect(eligible.state.consumed).toBe(true);
    expect(eligible.evidence?.status).toBe('eligible');
  });
});
