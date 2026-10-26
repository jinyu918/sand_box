import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return;
  if (parsed.username || parsed.password) return;
  const rendered = parsed.toString();
  if (/[\s&|<>^"']/u.test(rendered)) return;
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true, detached: true }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
}
