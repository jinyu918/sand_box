import dgram from 'node:dgram';
import net from 'node:net';
import * as dnsPacket from 'dns-packet';
import type { PolicyEngine } from './policy.js';

const TTL_SECONDS = 30;
const DNS_PORT = 53;
const MAX_TCP_MESSAGE = 4096;

export class DnsServer {
  private readonly policy: PolicyEngine;
  private readonly brokerIp: string;
  private udp: dgram.Socket | undefined;
  private tcp: net.Server | undefined;

  constructor(policy: PolicyEngine, brokerIp: string) {
    this.policy = policy;
    this.brokerIp = brokerIp;
  }

  createResponse(queryBuffer: Buffer): Buffer | null {
    let query: dnsPacket.Packet;
    try {
      query = dnsPacket.decode(queryBuffer);
    } catch {
      return null;
    }
    const flags = query.flags ?? 0;
    if (query.type !== 'query' || (flags & 0x8000) !== 0) return null;
    const id = query.id ?? 0;
    const question = query.questions?.[0];
    if (question === undefined) return encodeError(id, 1);
    const name = question.name.replace(/\.$/u, '').toLowerCase();
    const allowed = this.policy.canResolve(name);
    if (!allowed) {
      return dnsPacket.encode({
        type: 'response',
        id,
        flags: 0x8403,
        questions: query.questions,
        answers: [],
      });
    }
    const answers: dnsPacket.Answer[] = [];
    if (question.type === 'A') {
      answers.push({
        name: question.name,
        type: 'A',
        class: 'IN',
        ttl: TTL_SECONDS,
        data: this.brokerIp,
      });
    }
    return dnsPacket.encode({
      type: 'response',
      id,
      flags: 0x8400,
      questions: query.questions,
      answers,
    });
  }

  async start(bindHost = '0.0.0.0'): Promise<void> {
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', (message, remote) => {
      const response = this.createResponse(message);
      if (response !== null) this.udp?.send(response, remote.port, remote.address);
    });
    await bindUdp(this.udp, DNS_PORT, bindHost);

    this.tcp = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 2) return;
        const length = buffer.readUInt16BE(0);
        if (length > MAX_TCP_MESSAGE) {
          socket.destroy();
          return;
        }
        if (buffer.length < length + 2) return;
        const message = buffer.subarray(2, 2 + length);
        buffer = buffer.subarray(2 + length);
        const response = this.createResponse(message);
        if (response === null) return;
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(response.length, 0);
        socket.write(Buffer.concat([prefix, response]));
      });
      socket.on('error', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      this.tcp?.once('error', reject);
      this.tcp?.listen(DNS_PORT, bindHost, () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.udp?.close();
    this.udp = undefined;
    if (this.tcp !== undefined) {
      await new Promise<void>((resolve) => this.tcp?.close(() => resolve()));
      this.tcp = undefined;
    }
  }
}

function encodeError(id: number, rcode: number): Buffer {
  return dnsPacket.encode({
    type: 'response',
    id,
    flags: 0x8000 | (rcode & 0xf),
    questions: [],
    answers: [],
  });
}

function bindUdp(socket: dgram.Socket, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(port, host, () => resolve());
  });
}
