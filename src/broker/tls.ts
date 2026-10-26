import http from 'node:http';
import tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { CoveError } from '../core/errors.js';
import type { CertificateIssuer } from './ca.js';
import type { PolicyEngine } from './policy.js';

export interface TransparentTlsOptions {
  issuer: CertificateIssuer;
  policy: PolicyEngine;
  httpServer: http.Server;
}

export function createTransparentTlsServer(options: TransparentTlsOptions): tls.Server {
  const defaultCertificate = options.issuer.issue('no-sni.cove.invalid');
  const server = tls.createServer(
    {
      key: defaultCertificate.keyPem,
      cert: defaultCertificate.certPem,
      ALPNProtocols: ['http/1.1'],
      SNICallback(servername, callback) {
        try {
          if (!options.policy.canResolve(servername)) {
            callback(new CoveError('POLICY_DENIED', 'Host is not allowed'));
            return;
          }
          const issued = options.issuer.issue(servername);
          callback(null, tls.createSecureContext({ key: issued.keyPem, cert: issued.certPem }));
        } catch (error) {
          callback(error instanceof Error ? error : new Error('certificate issue failed'));
        }
      },
    },
    (socket) => {
      const host = typeof socket.servername === 'string' ? socket.servername.toLowerCase().replace(/\.$/u, '') : '';
      if (host.length === 0 || !options.policy.canResolve(host)) {
        socket.destroy();
        return;
      }
      (socket as Duplex & { coveHost?: string }).coveHost = host;
      options.httpServer.emit('connection', socket);
    },
  );
  server.on('tlsClientError', () => undefined);
  return server;
}

export function requestHost(socket: Duplex): string | undefined {
  return (socket as Duplex & { coveHost?: string }).coveHost;
}
