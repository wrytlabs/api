import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';

// Config
import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import redisConfig from './config/redis.config';
import telegramConfig from './config/telegram.config';
import aiConfig from './config/ai.config';
import alchemyConfig from './config/alchemy.config';
import oneinchConfig from './config/oneinch.config';
import krakenConfig from './config/kraken.config';
import deribitConfig from './config/deribit.config';
import { validationSchema } from './config/validation.schema';

// Core modules
import { DatabaseModule } from './core/database/database.module';
import { HealthModule } from './core/health/health.module';

// Integration modules
import { TelegramModule } from './integrations/telegram/telegram.module';
import { AiModule } from './integrations/ai/ai.module';
import { AlchemyModule } from './integrations/alchemy/alchemy.module';
import { OneInchModule } from './integrations/oneinch/oneinch.module';
import { KrakenModule } from './integrations/kraken/kraken.module';
import { DeribitModule } from './integrations/deribit/deribit.module';
import { SafeModule } from './integrations/safe/safe.module';
import { WalletModule } from './integrations/wallet/wallet.module';
import { PricesModule } from './integrations/prices/prices.module';

// Feature modules
import { AuthModule } from './modules/auth/auth.module';
import { UserProfileModule } from './modules/user-profile/user-profile.module';
import { BankAccountsModule } from './modules/bank-accounts/bank-accounts.module';
import { OffRampRoutesModule } from './modules/offramp-routes/offramp-routes.module';
import { AdminSettingsModule } from './modules/admin-settings/admin-settings.module';
import { OffRampExecutionsModule } from './modules/offramp-executions/offramp-executions.module';
import { UserWalletsModule } from './modules/user-wallets/user-wallets.module';
import { BillsModule } from './modules/bills/bills.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { AccountingModule } from './modules/accounting/accounting.module';
import { NamespaceModule } from './modules/namespace/namespace.module';

// Core modules
import { OffRampCoreModule } from './core/offramp/offramp-core.module';

// Common modules
import { EventsModule } from './common/events/events.module';
import { CombinedAuthGuard } from './common/guards/combined-auth.guard';
import { UserThrottlerGuard } from './common/guards/user-throttler.guard';

// App
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
      }),
      inject: [ConfigService],
    }),

    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, telegramConfig, aiConfig, alchemyConfig, oneinchConfig, krakenConfig, deribitConfig],
      validationSchema,
      validationOptions: {
        allowUnknown: true,
        abortEarly: false,
      },
    }),

    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV === 'development'
            ? {
                target: 'pino-pretty',
                options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                },
              }
            : undefined,
        level: process.env.LOG_LEVEL || 'info',
        autoLogging: false,
      },
    }),

    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.THROTTLE_TTL || '60', 10) * 1000,
        limit: parseInt(process.env.THROTTLE_LIMIT || '100', 10),
      },
    ]),

    ScheduleModule.forRoot(),

    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: '.',
      maxListeners: 10,
      verboseMemoryLeak: true,
    }),

    DatabaseModule,
    HealthModule,
    TelegramModule,
    AiModule,
    AlchemyModule,
    OneInchModule,
    KrakenModule,
    DeribitModule,
    SafeModule,
    AuthModule,
    UserProfileModule,
    BankAccountsModule,
    OffRampRoutesModule,
    AdminSettingsModule,
    OffRampExecutionsModule,
    OffRampCoreModule,
    WalletModule,
    PricesModule,
    UserWalletsModule,
    EventsModule,
    BillsModule,
    InvoicesModule,
    AccountingModule,
    NamespaceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: CombinedAuthGuard },
    { provide: APP_GUARD, useClass: UserThrottlerGuard },
  ],
})
export class AppModule {}
