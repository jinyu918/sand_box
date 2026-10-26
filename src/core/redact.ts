const REDACTED = '[redacted]';

export function redactText(input: string, secrets: readonly string[]): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    output = output.split(secret).join(REDACTED);
  }
  return output;
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '[invalid-url]';
  }
}

export function sanitizeLogValue(value: string, maxLength = 512): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .slice(0, maxLength);
}


