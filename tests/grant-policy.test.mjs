import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GRANT_MINUTES,
  MAX_GRANT_MINUTES,
  MIN_GRANT_MINUTES,
  normalizeGrantMinutes,
} from '../extension/grant-policy.js';

test('grant duration accepts only whole minutes inside the supported range', () => {
  assert.equal(normalizeGrantMinutes(MIN_GRANT_MINUTES), MIN_GRANT_MINUTES);
  assert.equal(normalizeGrantMinutes(60), 60);
  assert.equal(normalizeGrantMinutes(String(MAX_GRANT_MINUTES)), MAX_GRANT_MINUTES);
  assert.equal(normalizeGrantMinutes(0), DEFAULT_GRANT_MINUTES);
  assert.equal(normalizeGrantMinutes(MAX_GRANT_MINUTES + 1), DEFAULT_GRANT_MINUTES);
  assert.equal(normalizeGrantMinutes(1.5), DEFAULT_GRANT_MINUTES);
  assert.equal(normalizeGrantMinutes('invalid'), DEFAULT_GRANT_MINUTES);
});
