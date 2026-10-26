import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGlobalConfig } from '../core/config.js';
import { resolveCovePaths } from '../core/paths.js';
import { ProcessRunner } from '../docker/runner.js';
import { DockerRuntime } from '../docker/runtime.js';
import { createProtector } from '../vault/dpapi.js';
import { Vault } from '../vault/vault.js';

export interface CliContext {
  paths: ReturnType<typeof resolveCovePaths>;
  config: Awaited<ReturnType<typeof loadGlobalConfig>>;
  vault: Vault;
  docker: DockerRuntime;
}

export async function loadCliContext(): Promise<CliContext> {
  const paths = resolveCovePaths();
  const config = await loadGlobalConfig(paths);
  const vault = await Vault.open(paths.vaultFile, createProtector());
  const docker = new DockerRuntime(new ProcessRunner(), process.env.COVE_DOCKER ?? 'docker');
  return { paths, config, vault, docker };
}

export function packageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'package.json');
    if (existsSync(candidate)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate the Cove package root');
}

export const VERSION = '0.1.0';
