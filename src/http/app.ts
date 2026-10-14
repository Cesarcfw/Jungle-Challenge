import 'reflect-metadata';
import { Body, Catch, Controller, Get, Header, Headers, HttpCode, HttpException, Inject, Module, Param, Post, Query, UseGuards,
  type ArgumentsHost, type CanActivate, type ExceptionFilter } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import { WageringService } from '../application/wagering-service';
import { betInput, moneyProps, object, onlyKeys, text, uuid } from '../application/contracts';
import { DomainError } from '../domain/domain-error';
import { PostgresFinancialStore } from '../infrastructure/database/postgres-financial-store';
import { MessagingRuntime } from '../infrastructure/messaging/messaging-runtime';
import { infrastructureCode } from '../infrastructure/infrastructure-error';
import { Metrics } from '../infrastructure/observability/metrics';
import { auditMiddleware } from './audit-middleware';

// Extension point: replace with external OIDC validation and provider identity binding.
class ProviderIdentityGuard implements CanActivate { canActivate(): boolean { return true; } }

@Catch()
class ApiErrorFilter implements ExceptionFilter {
  constructor(private readonly metrics: Metrics) {}
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{ status(code: number): { json(body: unknown): void } }>();
    if (error instanceof HttpException) { response.status(error.getStatus()).json(error.getResponse()); return; }
    if (error instanceof DomainError) {
      const status = error.code.endsWith('_NOT_FOUND') ? 404 : error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : 400;
      response.status(status).json({ code: error.code, message: error.message }); return;
    }
    if (error instanceof UniqueConstraintViolationException) {
      response.status(409).json({ code: 'WALLET_ALREADY_EXISTS', message: 'Wallet already exists for player and currency.' }); return;
    }
    const request = host.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    this.metrics.log('error', 'INFRASTRUCTURE_ERROR', { ...(request.headers['x-correlation-id'] ? { correlationId: request.headers['x-correlation-id'] } : {}) }, { errorType: error instanceof Error ? error.name : 'Unknown' });
    const transient = infrastructureCode(error) === 'TRANSIENT_INFRASTRUCTURE_ERROR';
    response.status(transient ? 503 : 500).json({ code: transient ? 'INFRASTRUCTURE_UNAVAILABLE' : 'INTERNAL_PROCESSING_ERROR',
      message: transient ? 'Processing unavailable. Retry with the same idempotency key.' : 'Processing failed; consult transaction status before deciding to retry.' });
  }
}

@Controller('health')
class HealthController {
  constructor(@Inject(MessagingRuntime) private readonly messaging: MessagingRuntime) {}
  @Get('live') live() { return { status: 'ok' }; }
  @Get('ready') async ready() {
    try { await this.messaging.checkReady(); return { status: 'ready', postgres: 'ok', sqs: 'ok' }; }
    catch { throw new HttpException({ status: 'not_ready' }, 503); }
  }
}

@Controller('metrics')
class MetricsController {
  constructor(@Inject(Metrics) private readonly metrics: Metrics) {}
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  render() { return this.metrics.render(); }
}

@UseGuards(ProviderIdentityGuard)
@Controller('wallets')
class WalletController {
  constructor(@Inject(WageringService) private readonly service: WageringService) {}
  @Post()
  create(@Body() body: unknown, @Headers('x-correlation-id') correlation: string | undefined) {
    const input = object(body);
    onlyKeys(input, ['playerId', 'initialBalance']);
    return this.service.createWallet(uuid(input.playerId, 'playerId'), moneyProps(input.initialBalance), correlation ? text(correlation, 'correlationId') : randomUUID());
  }
  @Get(':walletId') get(@Param('walletId') id: string) { return this.service.getWallet(uuid(id, 'walletId')); }
  @Get(':walletId/ledger')
  ledger(@Param('walletId') id: string, @Query('cursor') cursor: unknown, @Query('limit') limit: unknown) {
    if (limit !== undefined && (typeof limit !== 'string' || !/^\d+$/.test(limit))) throw new DomainError('INVALID_LIMIT', 'Invalid ledger limit.');
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor)) throw new DomainError('INVALID_CURSOR', 'Invalid cursor.');
    return this.service.ledger(uuid(id, 'walletId'), limit === undefined ? 50 : Number(limit), cursor as string | undefined);
  }
  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(@Param('walletId') id: string, @Headers('x-correlation-id') correlation: string) {
    return this.service.reconcile(uuid(id, 'walletId'), correlation);
  }
}

@UseGuards(ProviderIdentityGuard)
@Controller('providers')
class ProviderController {
  constructor(@Inject(WageringService) private readonly service: WageringService) {}
  @Get(':providerId/wagering/transactions/:externalTransactionId')
  get(@Param('providerId') provider: string, @Param('externalTransactionId') external: string) {
    return this.service.getExternalTransaction(text(provider, 'providerId'), text(external, 'externalTransactionId'));
  }
}

@UseGuards(ProviderIdentityGuard)
@Controller('wagering/transactions')
class TransactionController {
  constructor(@Inject(WageringService) private readonly service: WageringService) {}
  @Post()
  @HttpCode(200)
  async submit(@Body() body: unknown, @Headers('idempotency-key') key: string | undefined, @Headers('x-correlation-id') correlation: string | undefined) {
    const result = await this.service.bet(betInput(body), text(key, 'Idempotency-Key'), correlation ? text(correlation, 'correlationId') : randomUUID());
    if (result.status === 'REJECTED') throw new HttpException(result, 422);
    if (result.status === 'PENDING_REFERENCE') throw new HttpException(result, 202);
    if (result.status === 'FAILED') throw new HttpException(result, 500);
    return result;
  }
  @Get(':transactionId') get(@Param('transactionId') id: string) { return this.service.getTransaction(uuid(id, 'transactionId')); }
}

export async function createApp(orm: MikroORM, options: { messaging?: boolean; logSink?: (entry: Record<string, unknown>) => void } = {}) {
  const metrics = new Metrics(orm, options.logSink);
  const service = new WageringService(new PostgresFinancialStore(orm), metrics);
  const messaging = new MessagingRuntime(orm, service, options.messaging ?? false, metrics);
  let running: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const worker = {
    onApplicationBootstrap() {
      timer = setInterval(() => {
        if (running) return;
        running = service.reprocessReferences().catch(error => {
          metrics.log('error', 'REFERENCE_WORKER_ERROR', {}, { errorType: error instanceof Error ? error.name : 'Unknown' });
        }).finally(() => { running = undefined; });
      }, 1000);
      timer.unref();
    },
    async onApplicationShutdown() { if (timer) clearInterval(timer); if (running) await running; },
  };
  @Module({
    controllers: [HealthController, WalletController, TransactionController, ProviderController, MetricsController],
    providers: [
      { provide: WageringService, useValue: service },
      { provide: Metrics, useValue: metrics },
      { provide: MessagingRuntime, useValue: messaging },
      { provide: 'REFERENCE_WORKER', useValue: worker },
      { provide: 'ORM_LIFECYCLE', useValue: { async onApplicationShutdown() { await worker.onApplicationShutdown(); await messaging.onApplicationShutdown(); await orm.close(true); } } },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
  app.use(auditMiddleware(metrics));
  app.useGlobalFilters(new ApiErrorFilter(metrics));
  app.enableShutdownHooks();
  return app;
}
