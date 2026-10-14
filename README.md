# Jungle Wagering Processor

Serviço para processar apostas e reversões por HTTP e SQS. Mantém saldo e ledger consistentes com pedidos duplicados, fora de ordem e concorrentes. O ambiente local executa três instâncias da API contra o mesmo PostgreSQL e LocalStack.

Stack: Bun 1.4.3, TypeScript estrito, NestJS 11, MikroORM 6.6 e PostgreSQL 17.

## Executar

Requisito: Docker com containers Linux e Docker Compose. Bun no host é opcional. Na pasta do projeto:

```powershell
docker compose up -d --build --wait
docker compose ps
```

As APIs ficam em http://localhost:3000, http://localhost:3001 e http://localhost:3002. O serviço migrate aplica as migrations antes das APIs e termina com código 0.

- `GET /health/live`: processo responde.
- `GET /health/ready`: PostgreSQL e SQS acessíveis; 503 enquanto alguma dependência estiver indisponível.
- PostgreSQL local: localhost:5432, banco jungle, usuário jungle, senha jungle.

Credenciais são fictícias para desenvolvimento. Para mudar portas ou a chave dos cursors, copie `.env.example` para `.env` e ajuste API_PORT, API2_PORT, API3_PORT, POSTGRES_PORT, SQS_PORT e CURSOR_SECRET.

Para parar preservando dados: `docker compose stop`. Para retomar: `docker compose up -d --wait`. Depois de mudar código, use `docker compose up -d --build --wait` para atualizar a imagem. `down -v` remove os dados do PostgreSQL.

## Testar e demonstrar

```powershell
docker compose --profile test run --rm tests
docker compose exec api bun run demo
docker compose exec api bun run demo:sqs
```

A suíte verifica tipos, 43 testes unitários e 40 de integração. Usa PostgreSQL e LocalStack reais, bancos jungle_test/jungle_schema_test e filas temporárias. Rode uma suíte por vez. Os bancos de teste são criados na primeira inicialização do volume.

Se estiver usando um volume antigo sem esses bancos, crie apenas os que estiverem ausentes:

```powershell
docker compose exec postgres psql -U jungle -d postgres -c "CREATE DATABASE jungle_test;"
docker compose exec postgres psql -U jungle -d postgres -c "CREATE DATABASE jungle_schema_test;"
```

A demo HTTP percorre aposta, replay, rejeição, vitória, derrota e reversões, terminando com saldo 100.00. A demo SQS entrega a mesma aposta duas vezes e espera um único débito de 25.00 sobre saldo 100.00. Cada demo cria uma wallet nova no banco local.

Para testar as três APIs e conferir o estado após reinício:

```powershell
docker compose exec api bun run smoke:compose
docker compose restart api api2 api3
docker compose up -d --wait --no-recreate api api2 api3
docker compose exec api bun run smoke:compose check
```

O smoke cobre 50 duplicatas, disputa de saldo, cursor entre instâncias, referência fora de ordem e SQS. A fase check usa IDs salvos no container api; se ele for recriado, rode a primeira fase novamente.

O GitHub Actions executa essa verificação em pushes e pull requests: sobe o Compose, roda tipos/testes, faz o smoke distribuído e confere recuperação após reinício. O resultado aparece na aba Actions do repositório; em caso de falha, o job mostra os logs dos serviços. Também permite execução manual.

## API

| Método | Caminho | Uso |
|---|---|---|
| POST | /wallets | Cria wallet e OPENING se saldo inicial positivo |
| GET | /wallets/:walletId | Saldo atual e versão |
| GET | /wallets/:walletId/ledger?limit=50&cursor=... | Histórico paginado |
| POST | /wallets/:walletId/reconciliation | Compara saldo e ledger, sem reparar divergências |
| POST | /wagering/transactions | BET, WIN, LOSS, REFUND ou ROLLBACK; exige Idempotency-Key |
| GET | /wagering/transactions/:transactionId | Resultado original da operação |
| GET | /providers/:providerId/wagering/transactions/:externalTransactionId | Consulta pela identidade externa |
| GET | /health/live e /health/ready | Saúde do processo e dependências |
| GET | /metrics | Métricas Prometheus |

Dinheiro entra como `{ "amount": "25.00", "currency": "BRL" }`, com valor string e duas casas. REFUND/ROLLBACK exigem referenceExternalTransactionId do mesmo provedor e valor igual ao original. WIN aceita referência opcional a BET; LOSS não movimenta saldo. OPENING é interno.

Submissão: 200 processada, 202 aguardando referência, 422 rejeitada por negócio, 409 conflito, 400 contrato inválido, 404 wallet ausente, 503 falha transitória e 500 falha interna/permanente ou replay de FAILED.

Mesma chave/corpo retorna o resultado persistido com idempotentReplay=true, incluindo o saldo observado na operação. Nova chave para a mesma identidade externa é conflito. Cursor deve ser reutilizado integralmente; limite válido 1..100. Ele fixa uma versão máxima do extrato e funciona entre instâncias com a mesma CURSOR_SECRET.

## Decisões e limites

Dinheiro usa decimal.js e NUMERIC(20,2). Lock pessimista por wallet, transações SQL, uniques e triggers protegem as invariantes. Inbox deduplica mensagens; outbox guarda eventos junto do dinheiro e publica após o commit. Eventos podem ser reenviados com o mesmo eventId; consumidores precisam deduplicá-los.

Referências ausentes são reprocessadas com backoff e TTL de 24 horas. Reconciliação lê saldo e ledger no mesmo snapshot. Logs JSON usam IDs de correlação sem payload financeiro; métricas cobrem resultados, duplicatas, retries, DLQ, locks, outbox e latência. Contadores são locais ao processo; gauges do banco são compartilhadas e não devem ser somadas entre réplicas.

Autenticação externa não foi implementada; há um guard de extensão e desenho OIDC documentados. Não houve teste de carga nem implementação de dashboard, tracing ou partidas dobradas. A validação por triggers percorre o histórico da wallet e precisa de avaliação para volumes maiores. LocalStack usa filas efêmeras: reiniciá-lo pode perder mensagens do broker; eventos ainda pendentes na outbox permanecem no PostgreSQL.

Diagramas, decisões técnicas e limitações: [ARCHITECTURE.md](ARCHITECTURE.md).
