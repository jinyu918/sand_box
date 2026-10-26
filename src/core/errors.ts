export type ErrorCode =
  | 'SETUP_REQUIRED'
  | 'DOCKER_UNAVAILABLE'
  | 'DOCKER_LINUX_REQUIRED'
  | 'IMAGE_MISSING'
  | 'VAULT_UNAVAILABLE'
  | 'VAULT_DECRYPT_FAILED'
  | 'SECRET_NOT_FOUND'
  | 'SECRET_INVALID'
  | 'CONFIG_INVALID'
  | 'PROJECT_INVALID'
  | 'PROJECT_SECRETS_FOUND'
  | 'SYMLINK_ESCAPE'
  | 'AGENT_UNKNOWN'
  | 'AGENT_CONFIG_INVALID'
  | 'MCP_UNKNOWN'
  | 'MCP_UNSUPPORTED'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_RUNNING'
  | 'DOCKER_FAILED'
  | 'BROKER_UNHEALTHY'
  | 'POLICY_DENIED'
  | 'USER_CANCELLED'
  | 'INTERNAL';

export class CoveError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  readonly exitCode: number;

  constructor(code: ErrorCode, message: string, options: { hint?: string; exitCode?: number; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CoveError';
    this.code = code;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}

export function isCoveError(error: unknown): error is CoveError {
  return error instanceof CoveError;
}

export function describeError(error: unknown): { code: string; message: string; hint?: string } {
  if (isCoveError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
    };
  }
  if (error instanceof Error) {
    return { code: 'INTERNAL', message: error.message };
  }
  return { code: 'INTERNAL', message: String(error) };
}
