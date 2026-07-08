import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	HttpStatus,
	Param,
	Patch,
	Post,
	Query,
	UseGuards,
} from '@nestjs/common';
import {
	ApiBody,
	ApiHeader,
	ApiOperation,
	ApiParam,
	ApiQuery,
	ApiSecurity,
	ApiTags,
} from '@nestjs/swagger';
import type { Namespace, NamespaceRole, User } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CurrentNamespace } from '../../common/decorators/current-namespace.decorator';
import { NamespaceGuard } from '../../common/guards/namespace.guard';
import { NamespaceService } from './namespace.service';
import { SafeService } from '../../integrations/safe/safe.service';
import type { ChainId } from '../../integrations/wallet/wallet.types';

@Controller('namespaces')
@ApiTags('Namespaces')
@ApiSecurity('api-key')
export class NamespaceController {
	constructor(
		private readonly namespaceService: NamespaceService,
		private readonly safeService: SafeService,
	) {}

	@Get()
	@ApiOperation({ summary: 'List namespaces the current user belongs to' })
	async list(@CurrentUser() user: User) {
		return this.namespaceService.list(user.id);
	}

	@Get(':id')
	@UseGuards(NamespaceGuard)
	@ApiOperation({ summary: 'Get namespace details' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	async get(@CurrentNamespace() namespace: Namespace) {
		return namespace;
	}

	@Patch(':id')
	@UseGuards(NamespaceGuard)
	@ApiOperation({ summary: 'Update namespace name (OWNER only)' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	@ApiBody({ schema: { type: 'object', properties: { name: { type: 'string' } } } })
	async update(
		@CurrentUser() user: User,
		@CurrentNamespace() namespace: Namespace,
		@Body('name') name: string,
	) {
		return this.namespaceService.update(namespace.id, user.id, name);
	}

	@Post(':id/members')
	@UseGuards(NamespaceGuard)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Add a member to the namespace (OWNER only)' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	@ApiBody({
		schema: {
			type: 'object',
			required: ['userId'],
			properties: {
				userId: { type: 'string' },
				role: { type: 'string', enum: ['OWNER', 'MEMBER'] },
			},
		},
	})
	async addMember(
		@CurrentUser() user: User,
		@CurrentNamespace() namespace: Namespace,
		@Body('userId') targetUserId: string,
		@Body('role') role?: NamespaceRole,
	) {
		const member = await this.namespaceService.addMember(
			namespace.id,
			user.id,
			targetUserId,
			role,
		);
		return { member };
	}

	@Delete(':id/members/:userId')
	@UseGuards(NamespaceGuard)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Remove a member from the namespace (OWNER only)' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiParam({ name: 'userId', description: 'User ID to remove' })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	async removeMember(
		@CurrentUser() user: User,
		@CurrentNamespace() namespace: Namespace,
		@Param('userId') targetUserId: string,
	) {
		await this.namespaceService.removeMember(namespace.id, user.id, targetUserId);
		return { message: 'Member removed' };
	}

	// ── Safe Wallets ────────────────────────────────────────────────────────────

	@Get(':id/safe/members')
	@UseGuards(NamespaceGuard)
	@ApiOperation({ summary: 'List linked wallet addresses for all namespace members' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	async getSafeMembers(@CurrentNamespace() namespace: Namespace) {
		const members = await this.safeService.getMemberWalletAddresses(namespace.id);
		return { members };
	}

	@Get(':id/safe/preview')
	@UseGuards(NamespaceGuard)
	@ApiOperation({ summary: 'Fetch owners and threshold of an existing Safe from the chain' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiQuery({ name: 'address', required: true, type: String })
	@ApiQuery({ name: 'chainId', required: false, type: Number, example: 1 })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	async previewSafe(
		@Query('address') address: string,
		@Query('chainId') chainIdParam = '1',
	) {
		const chainId = Number(chainIdParam) as ChainId;
		return this.safeService.getOwners(address, chainId);
	}

	@Get(':id/safe')
	@UseGuards(NamespaceGuard)
	@ApiOperation({ summary: 'List Safe wallets for the namespace' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiQuery({ name: 'chainId', required: false, type: Number })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	async listSafe(
		@CurrentNamespace() namespace: Namespace,
		@Query('chainId') chainIdParam?: string,
	) {
		const chainId = chainIdParam ? (Number(chainIdParam) as ChainId) : undefined;
		const wallets = await this.safeService.listWallets(namespace.id, chainId);
		return { wallets };
	}

	@Post(':id/safe')
	@UseGuards(NamespaceGuard)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Predict or get a Safe wallet for the namespace' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	@ApiBody({
		schema: {
			type: 'object',
			required: ['chainId'],
			properties: {
				chainId: { type: 'number', example: 1 },
				label: { type: 'string', example: 'primary' },
				owners: { type: 'array', items: { type: 'string' }, description: 'Owner addresses; operator wallet always added' },
			},
		},
	})
	async getOrCreateSafe(
		@CurrentNamespace() namespace: Namespace,
		@Body('chainId') chainId: ChainId,
		@Body('label') label = 'primary',
		@Body('owners') owners: string[] = [],
	) {
		const wallet = await this.safeService.getOrCreate(namespace.id, chainId, label, owners);
		return { wallet };
	}

	@Post(':id/safe/link')
	@UseGuards(NamespaceGuard)
	@HttpCode(HttpStatus.OK)
	@ApiOperation({ summary: 'Link an existing deployed Safe to this namespace' })
	@ApiParam({ name: 'id', description: 'Namespace ID' })
	@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
	@ApiBody({
		schema: {
			type: 'object',
			required: ['address', 'chainId'],
			properties: {
				address: { type: 'string', example: '0x...' },
				chainId: { type: 'number', example: 1 },
				label: { type: 'string', example: 'primary' },
			},
		},
	})
	async linkExistingSafe(
		@CurrentNamespace() namespace: Namespace,
		@Body('address') address: string,
		@Body('chainId') chainId: ChainId,
		@Body('label') label = 'primary',
	) {
		const wallet = await this.safeService.linkExisting(namespace.id, address, chainId, label);
		return { wallet };
	}
}
