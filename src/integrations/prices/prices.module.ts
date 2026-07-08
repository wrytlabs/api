import { Module } from '@nestjs/common';
import { OneInchModule } from '../oneinch/oneinch.module';
import { KrakenPriceAdapter } from './adapters/kraken.adapter';
import { DefiLlamaPriceAdapter } from './adapters/defillama.adapter';
import { OneInchPriceAdapter } from './adapters/oneinch.adapter';
import { PricesService } from './prices.service';
import { DailyRateService } from './daily-rate.service';
import { PricesController } from './prices.controller';

@Module({
  imports: [OneInchModule],
  providers: [PricesService, DailyRateService, KrakenPriceAdapter, DefiLlamaPriceAdapter, OneInchPriceAdapter],
  exports: [PricesService, DailyRateService],
  controllers: [PricesController],
})
export class PricesModule {}
