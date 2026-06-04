import {
	Controller,
	Get,
	Post,
	Put,
	Delete,
	Body,
	Param,
	HttpCode,
	HttpStatus,
	UseGuards,
} from '@nestjs/common';
import {
	ApiHeader,
	ApiTags,
	ApiOperation,
	ApiResponse,
	ApiSecurity,
	ApiParam,
	ApiBody,
} from '@nestjs/swagger';
import {
	BankAccountsService,
	CreateBankAccountDto,
	UpdateBankAccountDto,
} from './bank-accounts.service';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { NamespaceGuard } from '../../common/guards/namespace.guard';
import { CurrentNamespace } from '../../common/decorators/current-namespace.decorator';
import type { Namespace } from '@prisma/client';

@ApiTags('Bank Accounts')
@ApiSecurity('api-key')
@UseGuards(ScopesGuard, NamespaceGuard)
@RequireScopes('BANK')
@Controller('bank-accounts')
@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
export class BankAccountsController {
	constructor(private readonly service: BankAccountsService) {}

	@Get()
	@ApiOperation({ summary: 'List namespace bank accounts (IBAN masked)' })
	@ApiResponse({ status: 200 })
	list(@CurrentNamespace() namespace: Namespace) {
		return this.service.list(namespace.id);
	}

	@Post()
	@ApiOperation({ summary: 'Add a bank account to the namespace' })
	@ApiBody({
		schema: {
			type: 'object',
			required: ['iban', 'bic', 'currency'],
			properties: {
				iban: { type: 'string', example: 'CH5604835012345678009' },
				bic: { type: 'string', example: 'POFICHBEXXX' },
				currency: { type: 'string', enum: ['CHF', 'EUR'], example: 'CHF' },
				label: { type: 'string', example: 'main', description: 'Defaults to "default"' },
			},
		},
	})
	@ApiResponse({ status: 201 })
	@ApiResponse({ status: 409, description: 'Label already in use' })
	create(@CurrentNamespace() namespace: Namespace, @Body() dto: CreateBankAccountDto) {
		return this.service.create(namespace.id, dto);
	}

	@Put(':id')
	@ApiOperation({ summary: 'Update bank account metadata' })
	@ApiParam({ name: 'id', example: 'cm9ba001abc' })
	@ApiBody({
		schema: {
			type: 'object',
			properties: {
				bic: { type: 'string', example: 'POFICHBEXXX' },
				label: { type: 'string', example: 'savings' },
			},
		},
	})
	@ApiResponse({ status: 200 })
	@ApiResponse({ status: 404 })
	update(
		@CurrentNamespace() namespace: Namespace,
		@Param('id') id: string,
		@Body() dto: UpdateBankAccountDto,
	) {
		return this.service.update(id, namespace.id, dto);
	}

	@Delete(':id')
	@HttpCode(HttpStatus.NO_CONTENT)
	@RequireScopes('ADMIN')
	@ApiOperation({ summary: 'Delete a bank account (admin only)' })
	@ApiParam({ name: 'id' })
	@ApiResponse({ status: 204 })
	@ApiResponse({ status: 409, description: 'Account linked to an active route' })
	async remove(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
		await this.service.remove(id, namespace.id);
	}
}
