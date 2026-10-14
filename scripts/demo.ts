import { randomUUID } from 'node:crypto';

const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
async function post(path: string, body: unknown, key?: string) {
  const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
  const data = await response.json();
  console.log(JSON.stringify({ path, httpStatus: response.status, result: data }, null, 2));
  if (response.status >= 500) throw new Error('API unavailable; check migrations and server.');
  return data;
}
const wallet = await post('/wallets', { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }) as { id: string; playerId: string };
if (!wallet.id) throw new Error('Wallet creation failed.');
const bet = { providerId: 'demo-provider', externalTransactionId: randomUUID(), walletId: wallet.id, playerId: wallet.playerId,
  roundId: 'demo-round', gameId: 'demo-game', kind: 'BET', money: { amount: '80.00', currency: 'BRL' } };
const key = `demo-provider:${bet.externalTransactionId}`;
await post('/wagering/transactions', bet, key);
await post('/wagering/transactions', bet, key);
const second = { ...bet, externalTransactionId: randomUUID() };
await post('/wagering/transactions', second, `demo-provider:${second.externalTransactionId}`);
const refund = { ...bet, externalTransactionId: randomUUID(), kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId };
await post('/wagering/transactions', refund, `demo-provider:${refund.externalTransactionId}`);
const win = { ...bet, externalTransactionId: randomUUID(), kind: 'WIN', money: { amount: '40.00', currency: 'BRL' } };
await post('/wagering/transactions', win, `demo-provider:${win.externalTransactionId}`);
const loss = { ...bet, externalTransactionId: randomUUID(), kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } };
await post('/wagering/transactions', loss, `demo-provider:${loss.externalTransactionId}`);
const rollback = { ...win, externalTransactionId: randomUUID(), kind: 'ROLLBACK', referenceExternalTransactionId: win.externalTransactionId };
await post('/wagering/transactions', rollback, `demo-provider:${rollback.externalTransactionId}`);
const futureBet = { ...bet, externalTransactionId: randomUUID(), money: { amount: '10.00', currency: 'BRL' } };
const earlyRefund = { ...futureBet, externalTransactionId: randomUUID(), kind: 'REFUND', referenceExternalTransactionId: futureBet.externalTransactionId };
const pending = await post('/wagering/transactions', earlyRefund, `demo-provider:${earlyRefund.externalTransactionId}`) as { transactionId: string };
await post('/wagering/transactions', futureBet, `demo-provider:${futureBet.externalTransactionId}`);
let resolved = false;
for (let attempt = 0; attempt < 60; attempt++) {
  await Bun.sleep(100);
  const state = await (await fetch(`${base}/wagering/transactions/${pending.transactionId}`)).json() as { status: string };
  if (state.status === 'PROCESSED') { console.log(JSON.stringify({ resolvedReference: state }, null, 2)); resolved = true; break; }
}
if (!resolved) throw new Error('Reference did not resolve within demo wait window.');
console.log(JSON.stringify({ finalWallet: await (await fetch(`${base}/wallets/${wallet.id}`)).json() }, null, 2));
await post(`/wallets/${wallet.id}/reconciliation`, {});
console.log(JSON.stringify({ ledgerFirstPage: await (await fetch(`${base}/wallets/${wallet.id}/ledger?limit=2`)).json() }, null, 2));
console.log(JSON.stringify({ originalBet: await (await fetch(`${base}/providers/demo-provider/wagering/transactions/${bet.externalTransactionId}`)).json() }, null, 2));
console.log((await (await fetch(`${base}/metrics`)).text()).split('\n').filter(line => line.startsWith('wager_duplicates_total{') || line.startsWith('wallet_reconciliations_total{') || line.startsWith('outbox_lag_seconds ')).join('\n'));
