import type { GameCoreResult } from './types';

export type CapturePolicy = {
  method: 'radius' | 'pin' | 'automatic';
  distanceMeters: number;
  maxAccuracyMeters: number;
  maxSampleAgeSeconds: number;
  automatic?: { minimumProximitySeconds: number };
  pin?: { expiresAfterSeconds: number; maxAttempts: number; invalidateAfterUse: true };
};

export type LocationObservation = {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  observedAtMs: number;
  sequence: number;
};

export type CaptureEvidence = {
  status: 'eligible' | 'indeterminate';
  reason?: 'missing-sample' | 'invalid-sample' | 'future-sample' | 'stale-sample' | 'out-of-sequence' | 'poor-accuracy' | 'outside-range' | 'dwell-incomplete';
  distanceMeters?: number;
};

export type PinAttemptState = { expiresAtMs: number; attemptsRemaining: number; consumed: boolean };
export type PinAttemptResult = { state: PinAttemptState; accepted: boolean; reason?: 'expired' | 'locked' | 'already-used' | 'incorrect' };
export type PinCaptureResult = PinAttemptResult & { evidence?: CaptureEvidence };

const invalidPolicy = (fields: string[]): GameCoreResult<CapturePolicy> => ({
  ok: false,
  error: { code: 'INVALID_CAPTURE_POLICY', message: 'Capture policy is incomplete or invalid.', fields },
});

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function validateCapturePolicy(input: unknown): GameCoreResult<CapturePolicy> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return invalidPolicy(['policy']);
  const candidate = input as Record<string, unknown>;
  const fields: string[] = [];
  const allowed = ['method', 'distanceMeters', 'maxAccuracyMeters', 'maxSampleAgeSeconds', 'automatic', 'pin'];
  for (const key of Object.keys(candidate)) if (!allowed.includes(key)) fields.push(key);
  if (!['radius', 'pin', 'automatic'].includes(String(candidate.method))) fields.push('method');
  if (!isPositiveFinite(candidate.distanceMeters) || Number(candidate.distanceMeters) > 3000) fields.push('distanceMeters');
  if (!isPositiveFinite(candidate.maxAccuracyMeters) || Number(candidate.maxAccuracyMeters) > 3000) fields.push('maxAccuracyMeters');
  if (!Number.isInteger(candidate.maxSampleAgeSeconds) || Number(candidate.maxSampleAgeSeconds) < 1 || Number(candidate.maxSampleAgeSeconds) > 3600) fields.push('maxSampleAgeSeconds');

  let automatic: CapturePolicy['automatic'];
  let pin: CapturePolicy['pin'];
  if (candidate.method === 'automatic') {
    const value = candidate.automatic;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fields.push('automatic');
    else {
      const settings = value as Record<string, unknown>;
      if (Object.keys(settings).some(key => key !== 'minimumProximitySeconds')) fields.push('automatic');
      if (!Number.isInteger(settings.minimumProximitySeconds) || Number(settings.minimumProximitySeconds) < 1 || Number(settings.minimumProximitySeconds) > 3600) fields.push('automatic.minimumProximitySeconds');
      else automatic = { minimumProximitySeconds: Number(settings.minimumProximitySeconds) };
    }
    if (candidate.pin !== undefined) fields.push('pin');
  } else if (candidate.method === 'pin') {
    const value = candidate.pin;
    if (!value || typeof value !== 'object' || Array.isArray(value)) fields.push('pin');
    else {
      const settings = value as Record<string, unknown>;
      if (Object.keys(settings).some(key => !['expiresAfterSeconds', 'maxAttempts', 'invalidateAfterUse'].includes(key))) fields.push('pin');
      if (!Number.isInteger(settings.expiresAfterSeconds) || Number(settings.expiresAfterSeconds) < 1 || Number(settings.expiresAfterSeconds) > 86400) fields.push('pin.expiresAfterSeconds');
      if (!Number.isInteger(settings.maxAttempts) || Number(settings.maxAttempts) < 1 || Number(settings.maxAttempts) > 10) fields.push('pin.maxAttempts');
      if (settings.invalidateAfterUse !== true) fields.push('pin.invalidateAfterUse');
      if (Number.isInteger(settings.expiresAfterSeconds) && Number(settings.expiresAfterSeconds) >= 1 && Number(settings.expiresAfterSeconds) <= 86400
        && Number.isInteger(settings.maxAttempts) && Number(settings.maxAttempts) >= 1 && Number(settings.maxAttempts) <= 10 && settings.invalidateAfterUse === true) {
        pin = { expiresAfterSeconds: Number(settings.expiresAfterSeconds), maxAttempts: Number(settings.maxAttempts), invalidateAfterUse: true };
      }
    }
    if (candidate.automatic !== undefined) fields.push('automatic');
  } else {
    if (candidate.automatic !== undefined) fields.push('automatic');
    if (candidate.pin !== undefined) fields.push('pin');
  }

  if (fields.length) return invalidPolicy([...new Set(fields)]);
  return {
    ok: true,
    value: {
      method: candidate.method as CapturePolicy['method'],
      distanceMeters: candidate.distanceMeters as number,
      maxAccuracyMeters: candidate.maxAccuracyMeters as number,
      maxSampleAgeSeconds: candidate.maxSampleAgeSeconds as number,
      ...(automatic ? { automatic } : {}),
      ...(pin ? { pin } : {}),
    },
  };
}

function validObservation(sample: LocationObservation, nowMs: number, maxAgeMs: number): CaptureEvidence | undefined {
  const valid = Number.isFinite(sample.latitude) && sample.latitude >= -90 && sample.latitude <= 90
    && Number.isFinite(sample.longitude) && sample.longitude >= -180 && sample.longitude <= 180
    && Number.isFinite(sample.accuracyMeters) && sample.accuracyMeters > 0
    && Number.isFinite(sample.observedAtMs) && Number.isInteger(sample.sequence) && sample.sequence >= 0;
  if (!valid) return { status: 'indeterminate', reason: 'invalid-sample' };
  if (sample.observedAtMs > nowMs) return { status: 'indeterminate', reason: 'future-sample' };
  if (nowMs - sample.observedAtMs > maxAgeMs) return { status: 'indeterminate', reason: 'stale-sample' };
  return undefined;
}

function haversineMeters(a: LocationObservation, b: LocationObservation): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latA = radians(a.latitude);
  const latB = radians(b.latitude);
  const deltaLat = latB - latA;
  const deltaLng = radians(b.longitude - a.longitude);
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(latA) * Math.cos(latB) * Math.sin(deltaLng / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Evaluates server-held observations only. This decides evidence eligibility, never a capture outcome. */
export function evaluateCaptureEvidence(input: {
  policy: CapturePolicy;
  captor?: LocationObservation;
  target?: LocationObservation;
  nowMs: number;
  lastAcceptedSequence: { captor: number; target: number };
  proximityStartedAtMs?: number;
}): CaptureEvidence {
  const { policy, captor, target, nowMs } = input;
  if (!Number.isFinite(nowMs) || !captor || !target) return { status: 'indeterminate', reason: 'missing-sample' };
  const maxAgeMs = policy.maxSampleAgeSeconds * 1000;
  const captorIssue = validObservation(captor, nowMs, maxAgeMs);
  if (captorIssue) return captorIssue;
  const targetIssue = validObservation(target, nowMs, maxAgeMs);
  if (targetIssue) return targetIssue;
  if (captor.sequence <= input.lastAcceptedSequence.captor || target.sequence <= input.lastAcceptedSequence.target) {
    return { status: 'indeterminate', reason: 'out-of-sequence' };
  }
  if (captor.accuracyMeters > policy.maxAccuracyMeters || target.accuracyMeters > policy.maxAccuracyMeters) {
    return { status: 'indeterminate', reason: 'poor-accuracy' };
  }
  const distanceMeters = haversineMeters(captor, target);
  // Conservative overlap rule: the reported distance plus both accuracy radii must fit.
  if (distanceMeters + captor.accuracyMeters + target.accuracyMeters > policy.distanceMeters) {
    return { status: 'indeterminate', reason: 'outside-range', distanceMeters };
  }
  if (policy.method === 'automatic') {
    const startedAt = input.proximityStartedAtMs;
    if (startedAt === undefined || !Number.isFinite(startedAt) || startedAt > nowMs
      || nowMs - startedAt < (policy.automatic?.minimumProximitySeconds ?? Infinity) * 1000) {
      return { status: 'indeterminate', reason: 'dwell-incomplete', distanceMeters };
    }
  }
  return { status: 'eligible', distanceMeters };
}

/** PIN comparison stays in the authenticated server adapter; this pure gate never stores a PIN. */
export function applyPinAttempt(input: {
  policy: NonNullable<CapturePolicy['pin']>;
  state: PinAttemptState;
  nowMs: number;
  matches: boolean;
}): PinAttemptResult {
  const { policy, state, nowMs, matches } = input;
  if (!Number.isFinite(nowMs) || !Number.isFinite(state.expiresAtMs) || !Number.isInteger(state.attemptsRemaining)
    || state.attemptsRemaining < 0 || state.attemptsRemaining > policy.maxAttempts) {
    return { state, accepted: false, reason: 'locked' };
  }
  if (state.consumed) return { state, accepted: false, reason: 'already-used' };
  if (nowMs >= state.expiresAtMs) return { state, accepted: false, reason: 'expired' };
  if (state.attemptsRemaining === 0) return { state, accepted: false, reason: 'locked' };
  const nextState = { ...state, attemptsRemaining: state.attemptsRemaining - 1, consumed: matches };
  return matches
    ? { state: nextState, accepted: true }
    : { state: nextState, accepted: false, reason: nextState.attemptsRemaining === 0 ? 'locked' : 'incorrect' };
}

/** Verify fresh server GPS evidence before counting a PIN attempt. This still does not commit a capture. */
export function evaluatePinCaptureAttempt(input: {
  policy: CapturePolicy;
  state: PinAttemptState;
  nowMs: number;
  matches: boolean;
  captor?: LocationObservation;
  target?: LocationObservation;
  lastAcceptedSequence: { captor: number; target: number };
}): PinCaptureResult {
  if (input.policy.method !== 'pin' || !input.policy.pin) {
    return { state: input.state, accepted: false, reason: 'locked' };
  }
  const evidence = evaluateCaptureEvidence({
    policy: input.policy,
    captor: input.captor,
    target: input.target,
    nowMs: input.nowMs,
    lastAcceptedSequence: input.lastAcceptedSequence,
  });
  if (evidence.status !== 'eligible') return { state: input.state, accepted: false, reason: 'locked', evidence };
  return { ...applyPinAttempt({ policy: input.policy.pin, state: input.state, nowMs: input.nowMs, matches: input.matches }), evidence };
}
