import { describe, expect, it } from 'vitest';
import {
  hostMatches,
  isPrivateAddress,
  normalizeHost,
  normalizeRequestPath,
  pathMatchesPrefix,
} from '../src/core/net.js';

describe('host matching', () => {
  it('normalizes case and trailing dots', () => {
    expect(normalizeHost('API.Example.COM.')).toBe('api.example.com');
  });

  it('rejects IP literals and local names', () => {
    expect(() => normalizeHost('127.0.0.1')).toThrow();
    expect(() => normalizeHost('169.254.169.254')).toThrow();
    expect(() => normalizeHost('localhost')).toThrow();
    expect(() => normalizeHost('printer.local')).toThrow();
    expect(() => normalizeHost('metadata.internal')).toThrow();
    expect(() => normalizeHost('no-dot')).toThrow();
  });

  it('matches exact hosts and wildcard suffixes', () => {
    expect(hostMatches('api.anthropic.com', 'api.anthropic.com')).toBe(true);
    expect(hostMatches('api.anthropic.com', 'evil.anthropic.com')).toBe(false);
    expect(hostMatches('*.githubusercontent.com', 'raw.githubusercontent.com')).toBe(true);
    expect(hostMatches('*.githubusercontent.com', 'a.b.githubusercontent.com')).toBe(true);
    expect(hostMatches('*.githubusercontent.com', 'githubusercontent.com')).toBe(false);
    expect(hostMatches('*.githubusercontent.com', 'evilgithubusercontent.com')).toBe(false);
  });

  it('normalizes request paths before policy checks', () => {
    expect(normalizeRequestPath('/v1/../v1/messages?x=1')).toBe('/v1/messages');
    expect(normalizeRequestPath('https://api.example.com/v1/models')).toBe('/v1/models');
    expect(normalizeRequestPath('')).toBe('/');
  });

  it('enforces path prefixes on segment boundaries', () => {
    expect(pathMatchesPrefix('/v1/messages', ['/v1'])).toBe(true);
    expect(pathMatchesPrefix('/v1/messages', ['/v1/'])).toBe(true);
    expect(pathMatchesPrefix('/v10/messages', ['/v1'])).toBe(false);
    expect(pathMatchesPrefix('/anything', undefined)).toBe(true);
  });

  it('detects private and reserved addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
