import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiTags, ApiOperation, ApiSecurity, ApiParam, ApiBody, ApiQuery } from '@nestjs/swagger';
import { TransferClassification, AccountType, NormalBalance } from '@prisma/client';
import { AccountingService } from './accounting.service';
import { ScopesGuard } from '../../common/guards/scopes.guard';
import { RequireScopes } from '../../common/decorators/require-scopes.decorator';
import { NamespaceGuard } from '../../common/guards/namespace.guard';
import { CurrentNamespace } from '../../common/decorators/current-namespace.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { Namespace, User } from '@prisma/client';

@ApiTags('Accounting')
@ApiSecurity('api-key')
@UseGuards(ScopesGuard, NamespaceGuard)
@RequireScopes('USER')
@Controller('accounting')
@ApiHeader({ name: 'X-Namespace-Id', description: 'Namespace ID', required: true })
export class AccountingController {
  constructor(private readonly service: AccountingService) {}

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  @Post('addresses')
  @ApiOperation({ summary: 'Add a wallet address to track' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['address', 'chain'],
      properties: {
        address: { type: 'string', example: '0xd8da6bf26964af9d7eed9e03e53415d37aa96045' },
        chain: { type: 'string', example: 'eth-mainnet', description: 'Alchemy chain slug' },
        label: { type: 'string', example: 'Treasury' },
      },
    },
  })
  addAddress(
    @CurrentNamespace() namespace: Namespace,
    @Body() body: { address: string; chain: string; label?: string },
  ) {
    return this.service.addAddress(namespace.id, body.address, body.chain, body.label);
  }

  @Get('addresses')
  @ApiOperation({ summary: 'List tracked wallet addresses' })
  listAddresses(@CurrentNamespace() namespace: Namespace) {
    return this.service.listAddresses(namespace.id);
  }

  @Patch('addresses/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update label of a tracked address' })
  @ApiParam({ name: 'id' })
  updateAddress(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: { label?: string | null },
  ) {
    return this.service.updateAddress(namespace.id, id, body.label ?? null);
  }

  @Delete('addresses/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a tracked address and its transfers' })
  @ApiParam({ name: 'id' })
  removeAddress(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.removeAddress(namespace.id, id);
  }

  @Post('addresses/:id/sync')
  @ApiOperation({ summary: 'Sync all token transfers from Alchemy for this address' })
  @ApiParam({ name: 'id' })
  syncAddress(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.syncAddress(namespace.id, id);
  }

  // ---------------------------------------------------------------------------
  // Transfers
  // ---------------------------------------------------------------------------

  @Get('addresses/:id/transfers')
  @ApiOperation({ summary: 'List transfers for a tracked address' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'classification', required: false, enum: TransferClassification })
  @ApiQuery({ name: 'direction', required: false, enum: ['IN', 'OUT'] })
  @ApiQuery({ name: 'showHidden', required: false, type: Boolean })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  @ApiQuery({ name: 'take', required: false, type: Number })
  @ApiQuery({ name: 'sortBy', required: false })
  @ApiQuery({ name: 'sortDir', required: false, enum: ['asc', 'desc'] })
  getTransfers(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Query('search') search?: string,
    @Query('classification') classification?: string,
    @Query('direction') direction?: string,
    @Query('showHidden') showHidden?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
  ) {
    return this.service.getTransfers(namespace.id, id, {
      search,
      classification,
      direction,
      showHidden: showHidden === 'true',
      skip: skip ? parseInt(skip, 10) : 0,
      take: take ? parseInt(take, 10) : 50,
      sortBy,
      sortDir: (sortDir as 'asc' | 'desc') ?? 'desc',
    });
  }

  @Get('addresses/:id/summary')
  @ApiOperation({ summary: 'Accounting summary grouped by token (assets/liabilities)' })
  @ApiParam({ name: 'id' })
  getSummary(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.getSummary(namespace.id, id);
  }

  @Get('addresses/:id/token-balances')
  @ApiOperation({ summary: 'Per-token IN/OUT balance breakdown for a tracked address' })
  @ApiParam({ name: 'id' })
  getTokenBalances(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.getTokenBalances(namespace.id, id);
  }

  @Get('addresses/:id/token-overview')
  @ApiOperation({ summary: 'Per-token asset/liability/net overview and per-classification totals' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'quarter', required: false, type: Number })
  getTokenOverview(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Query('year') year?: string,
    @Query('quarter') quarter?: string,
  ) {
    return this.service.getTokenOverview(
      namespace.id, id,
      year ? parseInt(year, 10) : undefined,
      quarter ? parseInt(quarter, 10) : undefined,
    );
  }

  @Patch('transfers/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update classification, hidden flag, or notes on a transfer' })
  @ApiParam({ name: 'id' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        classification: { type: 'string', enum: Object.values(TransferClassification) },
        isHidden: { type: 'boolean' },
        chfValue: { type: 'string', nullable: true },
        notes: { type: 'string', nullable: true },
      },
    },
  })
  updateTransfer(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: { classification?: TransferClassification; isHidden?: boolean; chfValue?: string | null; notes?: string | null },
  ) {
    return this.service.updateTransfer(namespace.id, id, body);
  }

  // ---------------------------------------------------------------------------
  // Blacklist
  // ---------------------------------------------------------------------------

  @Get('blacklist')
  @ApiOperation({ summary: 'List globally blacklisted tokens (scam/spam)' })
  getBlacklist() {
    return this.service.getBlacklist();
  }

  @Post('blacklist')
  @ApiOperation({ summary: 'Add a token to the global blacklist' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['tokenAddress', 'chainId'],
      properties: {
        tokenAddress: { type: 'string' },
        chainId: { type: 'number' },
        tokenSymbol: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  })
  addToBlacklist(
    @CurrentUser() user: User,
    @Body() body: { tokenAddress: string; chainId: number; tokenSymbol?: string; reason?: string },
  ) {
    return this.service.addToBlacklist(user.id, body.tokenAddress, body.chainId, body.tokenSymbol, body.reason);
  }

  @Delete('blacklist/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a token from the blacklist' })
  @ApiParam({ name: 'id' })
  removeFromBlacklist(@Param('id') id: string) {
    return this.service.removeFromBlacklist(id);
  }

  // ---------------------------------------------------------------------------
  // Chart of accounts
  // ---------------------------------------------------------------------------

  @Get('accounts')
  @ApiOperation({ summary: 'List chart of accounts for the current user' })
  getAccounts(@CurrentNamespace() namespace: Namespace) {
    return this.service.getAccounts(namespace.id);
  }

  @Post('accounts')
  @ApiOperation({ summary: 'Create a new account' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['name', 'type', 'normalBalance'],
      properties: {
        name:          { type: 'string' },
        code:          { type: 'string' },
        type:          { type: 'string', enum: Object.values(AccountType) },
        normalBalance: { type: 'string', enum: Object.values(NormalBalance) },
        description:   { type: 'string' },
      },
    },
  })
  createAccount(
    @CurrentNamespace() namespace: Namespace,
    @Body() body: { name: string; code?: string; type: AccountType; normalBalance: NormalBalance; description?: string },
  ) {
    return this.service.createAccount(namespace.id, body);
  }

  @Patch('accounts/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update account name, code, or description' })
  @ApiParam({ name: 'id' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name:        { type: 'string' },
        code:        { type: 'string' },
        description: { type: 'string' },
      },
    },
  })
  updateAccount(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: { name?: string; code?: string; description?: string },
  ) {
    return this.service.updateAccount(namespace.id, id, body);
  }

  @Delete('accounts/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an account (only if no journal lines reference it)' })
  @ApiParam({ name: 'id' })
  deleteAccount(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.deleteAccount(namespace.id, id);
  }

  // ---------------------------------------------------------------------------
  // Classification templates
  // ---------------------------------------------------------------------------

  @Get('templates')
  @ApiOperation({ summary: 'List all classification templates (defaults + user overrides)' })
  getTemplates(@CurrentNamespace() namespace: Namespace) {
    return this.service.getTemplates(namespace.id);
  }

  @Put('templates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upsert a classification template override' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['classification', 'direction', 'debitAccountId', 'creditAccountId'],
      properties: {
        classification:  { type: 'string', enum: Object.values(TransferClassification) },
        direction:       { type: 'string', enum: ['IN', 'OUT', 'ANY'] },
        debitAccountId:  { type: 'string' },
        creditAccountId: { type: 'string' },
      },
    },
  })
  upsertTemplate(
    @CurrentNamespace() namespace: Namespace,
    @Body() body: { classification: TransferClassification; direction: string; debitAccountId: string; creditAccountId: string },
  ) {
    return this.service.upsertTemplate(namespace.id, body);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a template override (reverts to default)' })
  @ApiParam({ name: 'id' })
  deleteTemplate(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.deleteTemplate(namespace.id, id);
  }

  // ---------------------------------------------------------------------------
  // Trial balance
  // ---------------------------------------------------------------------------

  @Get('trial-balance')
  @ApiOperation({ summary: 'Trial balance across all addresses' })
  @ApiQuery({ name: 'addressId', required: false })
  getTrialBalance(@CurrentNamespace() namespace: Namespace, @Query('addressId') addressId?: string) {
    return this.service.getTrialBalance(namespace.id, addressId);
  }

  // ---------------------------------------------------------------------------
  // Journal entries
  // ---------------------------------------------------------------------------

  @Get('addresses/:id/journal')
  @ApiOperation({ summary: 'Journal entries for a tracked address' })
  @ApiParam({ name: 'id' })
  getJournalEntries(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.getJournalEntries(namespace.id, id);
  }

  // ---------------------------------------------------------------------------
  // Counterparty labels
  // ---------------------------------------------------------------------------

  @Get('counterparty-labels')
  @ApiOperation({ summary: 'Get all counterparty address labels for the current user' })
  getCounterpartyLabels(@CurrentNamespace() namespace: Namespace) {
    return this.service.getCounterpartyLabels(namespace.id);
  }

  @Post('counterparty-labels')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upsert (or delete when label is null) a counterparty label' })
  upsertCounterpartyLabel(
    @CurrentNamespace() namespace: Namespace,
    @Body() body: { address: string; label: string | null },
  ) {
    return this.service.upsertCounterpartyLabel(namespace.id, body.address, body.label);
  }

  // ---------------------------------------------------------------------------
  // Token year-end prices
  // ---------------------------------------------------------------------------

  @Get('addresses/:id/token-prices')
  @ApiOperation({ summary: 'Get user-entered year-end prices for all tokens of an address' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'year', required: true, type: Number })
  getTokenPrices(@CurrentNamespace() namespace: Namespace, @Param('id') id: string, @Query('year') year: string) {
    return this.service.getTokenPrices(namespace.id, id, parseInt(year, 10));
  }

  @Post('addresses/:id/token-prices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upsert a year-end CHF price for a token' })
  @ApiParam({ name: 'id' })
  upsertTokenPrice(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: { year: number; tokenSymbol: string; priceChf: string | null },
  ) {
    return this.service.upsertTokenPrice(namespace.id, id, body.year, body.tokenSymbol, body.priceChf);
  }

  // ---------------------------------------------------------------------------
  // Adjustments (manual corrections / profit / loss entries)
  // ---------------------------------------------------------------------------

  @Get('addresses/:id/adjustments')
  @ApiOperation({ summary: 'List manual adjustments for an address' })
  @ApiParam({ name: 'id' })
  @ApiQuery({ name: 'year', required: false, type: Number })
  @ApiQuery({ name: 'quarter', required: false, type: Number })
  getAdjustments(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Query('year') year?: string,
    @Query('quarter') quarter?: string,
  ) {
    return this.service.getAdjustments(
      namespace.id, id,
      year ? parseInt(year, 10) : undefined,
      quarter ? parseInt(quarter, 10) : undefined,
    );
  }

  @Post('addresses/:id/adjustments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a manual adjustment entry' })
  @ApiParam({ name: 'id' })
  createAdjustment(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: { date?: string; type: string; tokenSymbol?: string; amount?: string; chfValue?: string; note?: string },
  ) {
    return this.service.createAdjustment(namespace.id, id, body);
  }

  @Patch('adjustments/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a manual adjustment entry' })
  @ApiParam({ name: 'id' })
  updateAdjustment(
    @CurrentNamespace() namespace: Namespace,
    @Param('id') id: string,
    @Body() body: { date?: string; type?: string; tokenSymbol?: string | null; amount?: string | null; chfValue?: string | null; note?: string | null },
  ) {
    return this.service.updateAdjustment(namespace.id, id, body);
  }

  @Delete('adjustments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a manual adjustment entry' })
  @ApiParam({ name: 'id' })
  deleteAdjustment(@CurrentNamespace() namespace: Namespace, @Param('id') id: string) {
    return this.service.deleteAdjustment(namespace.id, id);
  }
}
