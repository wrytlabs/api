import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OffRampExecutionsService } from './offramp-executions.service';
import { OffRampExecutionsController } from './offramp-executions.controller';
import { OFFRAMP_QUEUE } from '../../core/offramp/offramp.queue';

@Module({
  imports: [BullModule.registerQueue({ name: OFFRAMP_QUEUE })],
  providers: [OffRampExecutionsService],
  controllers: [OffRampExecutionsController],
  exports: [OffRampExecutionsService],
})
export class OffRampExecutionsModule {}
