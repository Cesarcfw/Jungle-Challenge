export function infrastructureCode(error: unknown): 'TRANSIENT_INFRASTRUCTURE_ERROR' | 'PERMANENT_INFRASTRUCTURE_ERROR' {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
    const record = current as Record<string, unknown>;
    const code = String(record.code ?? '');
    const name = String(record.name ?? '');
    if (['40001','40P01','55P03','57014','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN'].includes(code) ||
        code.startsWith('08') || code.startsWith('57P') || ['TimeoutError','KnexTimeoutError'].includes(name)) return 'TRANSIENT_INFRASTRUCTURE_ERROR';
    current = record.cause;
  }
  return 'PERMANENT_INFRASTRUCTURE_ERROR';
}
