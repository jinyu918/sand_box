import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GLOBAL_CONFIG,
  validateGlobalConfig,
  validateMcpState,
  validateProjectConfig,
} from '../src/core/config.js';

describe('config validation', () => {
  it('fills defaults', () => {
    expect(validateGlobalConfig({ version: 1 })).toEqual(DEFAULT_GLOBAL_CONFIG);
  });

  it('rejects unsafe ports and memory values', () => {
    expect(() => validateGlobalConfig({ version: 1, ui: { port: 80 } })).toThrow();
    expect(() => validateGlobalConfig({ version: 1, resources: { memory: '4gb' } })).toThrow();
    expect(() => validateGlobalConfig({ version: 1, resources: { cpus: 0 } })).toThrow();
  });

  it('validates project extra hosts', () => {
    const config = validateProjectConfig({
      version: 1,
      egress: { extraHosts: [{ id: 'docs', host: 'api.example.com', methods: ['get'], paths: ['/v1'] }] },
    });
    expect(config.egress.extraHosts[0]).toEqual({
      id: 'docs',
      host: 'api.example.com',
      methods: ['GET'],
      paths: ['/v1'],
    });
    expect(() =>
      validateProjectConfig({
        version: 1,
        egress: { extraHosts: [{ id: 'x', host: '127.0.0.1', methods: ['GET'] }] },
      }),
    ).toThrow();
  });

  it('rejects duplicate MCP presets', () => {
    expect(() =>
      validateMcpState({
        version: 1,
        servers: [
          { preset: 'github', enabled: true },
          { preset: 'github', enabled: true },
        ],
      }),
    ).toThrow();
  });

  it('accepts a project path without creating files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cove-config-'));
    const config = validateProjectConfig({ version: 1 });
    expect(config.security.allowProjectSecretFiles).toBe(false);
    expect(dir.length).toBeGreaterThan(0);
  });
});
