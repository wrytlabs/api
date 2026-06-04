import { Module } from '@nestjs/common';
import { NamespaceService } from './namespace.service';
import { NamespaceController } from './namespace.controller';
import { SafeModule } from '../../integrations/safe/safe.module';

@Module({
	imports: [SafeModule],
	providers: [NamespaceService],
	exports: [NamespaceService],
	controllers: [NamespaceController],
})
export class NamespaceModule {}
