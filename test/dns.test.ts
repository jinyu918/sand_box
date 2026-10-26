import * as dnsPacket from 'dns-packet';
import { describe, expect, it } from 'vitest';
import { DnsServer } from '../src/broker/dns.js';
import { PolicyEngine } from '../src/broker/policy.js';
import type { BrokerConfig } from '../src/broker/types.js';

const config: Pick<BrokerConfig, 'policy' | 'credentials'> = {
  policy: [
    { id: 'anthropic', host: 'api.anthropic.com', methods: ['POST'] },
    { id: 'wild', host: '*.example.com', methods: ['GET'] },
  ],
  credentials: [],
};

function query(name: string, type: 'A' | 'AAAA' = 'A'): Buffer {
  return dnsPacket.encode({
    type: 'query',
    id: 42,
    flags: 0x0100,
    questions: [{ name, type, class: 'IN' }],
  });
}

describe('broker DNS', () => {
  it('answers allowed hosts with the broker IP', () => {
    const server = new DnsServer(new PolicyEngine(config), '172.20.0.2');
    const response = server.createResponse(query('API.Anthropic.com.'));
    expect(response).not.toBeNull();
    const decoded = dnsPacket.decode(response as Buffer);
    expect(decoded.type).toBe('response');
    expect(decoded.answers).toHaveLength(1);
    expect(decoded.answers?.[0]?.type).toBe('A');
    expect((decoded.answers?.[0] as { data?: string } | undefined)?.data).toBe('172.20.0.2');
    expect((decoded.flags ?? 0) & 0x000f).toBe(0);
  });

  it('returns NXDOMAIN for unknown hosts and does not forward the query', () => {
    const server = new DnsServer(new PolicyEngine(config), '172.20.0.2');
    const decoded = dnsPacket.decode(server.createResponse(query('attacker.example.net')) as Buffer);
    expect((decoded.flags ?? 0) & 0x000f).toBe(3);
    expect(decoded.answers ?? []).toHaveLength(0);
  });

  it('answers AAAA with NOERROR and no records, forcing IPv4', () => {
    const server = new DnsServer(new PolicyEngine(config), '172.20.0.2');
    const decoded = dnsPacket.decode(server.createResponse(query('api.anthropic.com', 'AAAA')) as Buffer);
    expect((decoded.flags ?? 0) & 0x000f).toBe(0);
    expect(decoded.answers ?? []).toHaveLength(0);
  });

  it('supports wildcard policy names', () => {
    const server = new DnsServer(new PolicyEngine(config), '172.20.0.2');
    const decoded = dnsPacket.decode(server.createResponse(query('sub.example.com')) as Buffer);
    expect((decoded.answers?.[0] as { data?: string } | undefined)?.data).toBe('172.20.0.2');
  });
});
