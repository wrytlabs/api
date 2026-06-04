import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SafeService } from './safe.service';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { NamespaceGuard } from '../../common/guards/namespace.guard';
import { CurrentNamespace } from '../../common/decorators/current-namespace.decorator';
import type { Namespace } from '@prisma/client';
import type { ChainId } from '../wallet/wallet.types';

@Controller('safe')
@ApiTags('Safe')
@UseGuards(ScopesGuard, NamespaceGuard)
@ApiSecurity('api-key')
@RequireScopes('SAFE')
@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
export class SafeController {
	constructor(private readonly safeService: SafeService) {}

	@Get('wallets')
	@ApiOperation({ summary: 'List Safe wallets for the current namespace' })
	@ApiQuery({ name: 'chainId', required: false, type: Number, example: 1 })
	async listWallets(
		@CurrentNamespace() namespace: Namespace,
		@Query('chainId') chainIdParam?: string,
	) {
		const chainId = chainIdParam ? (Number(chainIdParam) as ChainId) : undefined;
		const wallets = await this.safeService.listWallets(namespace.id, chainId);
		return { wallets };
	}
}
