import { homedir } from 'node:os';
import path from 'node:path';

export interface CovePaths {
  readonly home: string;
  readonly configFile: string;
  readonly vaultFile: string;
  readonly mcpFile: string;
  readonly caDir: string;
  readonly caCertFile: string;
  readonly caBundleFile: string;
  readonly publicRootsFile: string;
  readonly sessionsDir: string;
}

export interface PathEnvironment {
  readonly COVE_HOME?: string | undefined;
}

export function resolveCovePaths(
  env: PathEnvironment = process.env,
  home: string = homedir(),
): CovePaths {
  const override = env.COVE_HOME?.trim();
  const root = override ? path.resolve(override) : path.join(home, '.cove');
  return {
    home: root,
    configFile: path.join(root, 'config.json'),
    vaultFile: path.join(root, 'vault.json'),
    mcpFile: path.join(root, 'mcp.json'),
    caDir: path.join(root, 'ca'),
    caCertFile: path.join(root, 'ca', 'ca.pem'),
    caBundleFile: path.join(root, 'ca', 'bundle.pem'),
    publicRootsFile: path.join(root, 'ca', 'public-roots.pem'),
    sessionsDir: path.join(root, 'sessions'),
  };
}

export function sessionPaths(paths: CovePaths, sessionId: string): {
  readonly dir: string;
  readonly configDir: string;
  readonly auditDir: string;
  readonly auditFile: string;
  readonly sessionFile: string;
} {
  const dir = path.join(paths.sessionsDir, sessionId);
  return {
    dir,
    configDir: path.join(dir, 'config'),
    auditDir: path.join(dir, 'audit'),
    auditFile: path.join(dir, 'audit', 'audit.jsonl'),
    sessionFile: path.join(dir, 'session.json'),
  };
}
