import { createHash } from 'node:crypto';

export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Canonical JSON does not accept undefined.');
  return encoded;
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}
