import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AuditEvent } from './types.js';

export class AuditLogger {
  private readonly file: string;
  private readonly maxBytes: number;
  private chain: Promise<void> = Promise.resolve();
  private warned = false;

  constructor(file: string, maxBytes: number) {
    this.file = file;
    this.maxBytes = Math.max(1024 * 1024, maxBytes);
  }

  write(event: AuditEvent): void {
    const line = `${JSON.stringify(event)}\n`;
    this.chain = this.chain
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await this.rotateIfNeeded();
        await appendFile(this.file, line, { encoding: 'utf8', mode: 0o600 });
      })
      .catch(() => {
        if (!this.warned) {
          this.warned = true;
          process.stderr.write('cove-broker: audit write failed\n');
        }
      });
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const info = await stat(this.file);
      if (info.size < this.maxBytes) return;
      const rotated = `${this.file}.1`;
      await rm(rotated, { force: true }).catch(() => undefined);
      await rename(this.file, rotated);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
