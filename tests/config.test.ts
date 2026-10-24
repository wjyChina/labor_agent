import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

test('environment overrides .env without mutating inherited environment; validates URLs', () => {
  const before = process.env.LABOR_MODEL;
  const c = loadConfig({ LABOR_MODEL: 'explicit-model', LABOR_API_KEY: 'explicit-test-key', LABOR_BASE_URL: 'https://example.com/v1/' });
  assert.equal(c.model, 'explicit-model'); assert.equal(c.apiKey, 'explicit-test-key');
  assert.equal(c.baseUrl, 'https://example.com/v1'); assert.equal(process.env.LABOR_MODEL, before);
  assert.throws(() => loadConfig({ LABOR_BASE_URL: 'https://name:secret@example.com' }), /HTTP\(S\)/);
  assert.throws(() => loadConfig({ LABOR_BASE_URL: 'file:///tmp/test' }), /HTTP\(S\)/);
});
