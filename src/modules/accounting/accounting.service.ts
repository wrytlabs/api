import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import {
  TransferClassification,
  AccountType,
  NormalBalance,
  JournalLineType,
} from '@prisma/client';
import { PrismaService } from '../../core/database/prisma.service';
import { AlchemyService } from '../../integrations/alchemy/alchemy.service';
import { DailyRateService } from '../../integrations/prices/daily-rate.service';
import { resolveChfRateBase } from '../../config/tokens.config';

const CHAIN_ID_MAP: Record<string, number> = {
  'eth-mainnet':     1,
  'polygon-mainnet': 137,
  'opt-mainnet':     10,
  'arb-mainnet':     42161,
  'base-mainnet':    8453,
};

const MAX_PER_PAGE = 1000;

// Extracts the numeric log/event index from Alchemy uniqueId.
// Format: "<txHash>:log:<n>" where <n> may be decimal ("145") or hex ("0x91").
// parseInt without a radix auto-detects the 0x prefix — do NOT pass radix 10.
function parseLogIndex(uniqueId: string): number {
  const last = uniqueId.split(':').at(-1);
  const n = parseInt(last ?? '');
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Default chart of accounts
// ---------------------------------------------------------------------------

const DEFAULT_ACCOUNTS = [
  { name: 'Crypto Assets',      code: '1000', type: AccountType.ASSET,     normalBalance: NormalBalance.DEBIT  },
  { name: 'Internal Transfers', code: '1900', type: AccountType.ASSET,     normalBalance: NormalBalance.DEBIT  },
  { name: 'Loans Payable',      code: '2000', type: AccountType.LIABILITY, normalBalance: NormalBalance.CREDIT },
  { name: 'Equity',             code: '3000', type: AccountType.EQUITY,    normalBalance: NormalBalance.CREDIT },
  { name: 'Income',             code: '4000', type: AccountType.REVENUE,   normalBalance: NormalBalance.CREDIT },
  { name: 'Swap Proceeds',      code: '4100', type: AccountType.REVENUE,   normalBalance: NormalBalance.CREDIT },
  { name: 'Expenses',           code: '6000', type: AccountType.EXPENSE,   normalBalance: NormalBalance.DEBIT  },
  { name: 'Swap Cost',          code: '6100', type: AccountType.EXPENSE,   normalBalance: NormalBalance.DEBIT  },
];

// Default debit/credit account names per classification + direction.
// Direction "ANY" matches both IN and OUT when no direction-specific template exists.
const DEFAULT_TEMPLATES: Record<string, { debit: string; credit: string }> = {
  [`${TransferClassification.ASSET}:ANY`]:     { debit: 'Crypto Assets', credit: 'Income'          },
  [`${TransferClassification.RECEIVED}:ANY`]:  { debit: 'Crypto Assets', credit: 'Income'          },
  [`${TransferClassification.SWAP_IN}:ANY`]:   { debit: 'Crypto Assets', credit: 'Swap Proceeds'   },
  [`${TransferClassification.LIABILITY}:ANY`]: { debit: 'Crypto Assets', credit: 'Loans Payable'   },
  [`${TransferClassification.PAYMENT}:ANY`]:   { debit: 'Expenses',      credit: 'Crypto Assets'   },
  [`${TransferClassification.SWAP_OUT}:ANY`]:  { debit: 'Swap Cost',     credit: 'Crypto Assets'   },
  [`${TransferClassification.TRANSFER}:IN`]:   { debit: 'Crypto Assets', credit: 'Internal Transfers' },
  [`${TransferClassification.TRANSFER}:OUT`]:  { debit: 'Internal Transfers', credit: 'Crypto Assets'  },
};

@Injectable()
export class AccountingService {
  private readonly logger = new Logger(AccountingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alchemy: AlchemyService,
    private readonly dailyRates: DailyRateService,
  ) {}

  /** Estimates chfValue for a token amount from its daily reference-asset close rate. */
  private async estimateChfValue(
    tokenSymbol: string | null,
    amountFormatted: string | null,
    timestamp: Date | null,
  ): Promise<{ chfValue?: string; chfValueIsEstimate: boolean }> {
    const base = resolveChfRateBase(tokenSymbol);
    if (!base || !amountFormatted || !timestamp) return { chfValueIsEstimate: false };

    const rate = await this.dailyRates.getRate(base, timestamp);
    if (rate === null) return { chfValueIsEstimate: false };

    return {
      chfValue: String(parseFloat(amountFormatted) * rate),
      // The ZCHF/CHF peg is definitional, not a market-derived estimate.
      chfValueIsEstimate: base !== 'CHF',
    };
  }

  // ---------------------------------------------------------------------------
  // Addresses
  // ---------------------------------------------------------------------------

  async addAddress(namespaceId: string, address: string, chain: string, label?: string) {
    const chainId = CHAIN_ID_MAP[chain];
    if (!chainId) throw new ConflictException(`Unsupported chain: ${chain}`);
    const normalised = address.toLowerCase();
    return this.prisma.accountingAddress.upsert({
      where: { namespaceId_address_chainId: { namespaceId, address: normalised, chainId } },
      create: { namespaceId, address: normalised, chain, chainId, label },
      update: { label, chain },
    });
  }

  async listAddresses(namespaceId: string) {
    return this.prisma.accountingAddress.findMany({
      where: { namespaceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateAddress(namespaceId: string, id: string, label: string | null) {
    const row = await this.prisma.accountingAddress.findFirst({ where: { id, namespaceId } });
    if (!row) throw new NotFoundException('Address not found');
    return this.prisma.accountingAddress.update({ where: { id }, data: { label: label ?? null } });
  }

  async removeAddress(namespaceId: string, id: string) {
    const row = await this.prisma.accountingAddress.findFirst({ where: { id, namespaceId } });
    if (!row) throw new NotFoundException('Address not found');
    await this.prisma.accountingAddress.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Sync
  // ---------------------------------------------------------------------------

  async syncAddress(namespaceId: string, id: string): Promise<{ synced: number }> {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');

    const blacklist = await this.prisma.accountingBlacklist.findMany({
      where: { chainId: acct.chainId },
      select: { tokenAddress: true },
    });
    const blacklisted = new Set(blacklist.map(b => b.tokenAddress.toLowerCase()));

    const all = await this.fetchAllTransfers(acct.chain, acct.address);
    const seen = new Set<string>();
    const unique = all.filter(t => {
      if (seen.has(t.uniqueId)) return false;
      seen.add(t.uniqueId);
      return true;
    });

    const addr = acct.address.toLowerCase();
    const rows = await Promise.all(unique.map(async t => {
      const tokenAddr = t.rawContract.address?.toLowerCase() ?? null;
      const decimalsHex = t.rawContract.decimal;
      const tokenDecimals = decimalsHex
        ? (decimalsHex.startsWith('0x') ? parseInt(decimalsHex, 16) : parseInt(decimalsHex, 10))
        : null;
      const blockNumber = t.blockNum ? parseInt(t.blockNum, 16) : null;
      const logIndex = parseLogIndex(t.uniqueId);

      const symbol = t.asset ?? null;
      const amountFormatted = t.value !== null && t.value !== undefined ? String(t.value) : null;
      const timestamp = t.metadata?.blockTimestamp ? new Date(t.metadata.blockTimestamp) : null;
      const { chfValue, chfValueIsEstimate } = await this.estimateChfValue(symbol, amountFormatted, timestamp);

      return {
        accountingAddressId: acct.id,
        chainId: acct.chainId,
        txHash: t.hash,
        alchemyUniqueId: t.uniqueId,
        blockNum: t.blockNum,
        blockNumber,
        logIndex,
        timestamp,
        direction: t.to?.toLowerCase() === addr ? 'IN' : 'OUT',
        tokenAddress: tokenAddr,
        tokenSymbol: symbol,
        tokenDecimals,
        tokenType: t.category,
        amountRaw: t.rawContract.value ?? null,
        amountFormatted,
        fromAddress: t.from.toLowerCase(),
        toAddress: t.to?.toLowerCase() ?? null,
        isHidden: tokenAddr ? blacklisted.has(tokenAddr) : false,
        chfValue,
        chfValueIsEstimate,
      };
    }));

    const result = await this.prisma.accountingTransfer.createMany({
      data: rows,
      skipDuplicates: true,
    });

    // Backfill blockNumber/logIndex for records synced before these fields existed
    const metaMap = new Map(rows.map(r => [r.alchemyUniqueId, { blockNumber: r.blockNumber, logIndex: r.logIndex }]));
    const needsBackfill = await this.prisma.accountingTransfer.findMany({
      where: { accountingAddressId: acct.id, logIndex: null },
      select: { id: true, alchemyUniqueId: true },
    });
    if (needsBackfill.length > 0) {
      const updates = needsBackfill
        .filter(r => metaMap.has(r.alchemyUniqueId))
        .map(r => {
          const meta = metaMap.get(r.alchemyUniqueId)!;
          return this.prisma.accountingTransfer.update({
            where: { id: r.id },
            data: { blockNumber: meta.blockNumber, logIndex: meta.logIndex },
          });
        });
      await this.prisma.$transaction(updates);
      this.logger.log(`Backfilled block/log indices for ${updates.length} transfers`);
    }

    // Backfill chfValue for existing transfers still missing it (e.g. synced before
    // this token's reference asset had daily rate coverage, or before this feature existed)
    const missingChf = await this.prisma.accountingTransfer.findMany({
      where: { accountingAddressId: acct.id, chfValue: null, tokenSymbol: { not: null } },
      select: { id: true, tokenSymbol: true, amountFormatted: true, timestamp: true },
    });
    if (missingChf.length > 0) {
      const estimates = await Promise.all(
        missingChf.map(async t => ({
          id: t.id,
          ...(await this.estimateChfValue(t.tokenSymbol, t.amountFormatted, t.timestamp)),
        })),
      );
      const updates = estimates
        .filter(e => e.chfValue !== undefined)
        .map(e =>
          this.prisma.accountingTransfer.update({
            where: { id: e.id },
            data: { chfValue: e.chfValue, chfValueIsEstimate: e.chfValueIsEstimate },
          }),
        );
      if (updates.length > 0) {
        await this.prisma.$transaction(updates);
        this.logger.log(`Backfilled CHF estimate for ${updates.length} transfers`);
      }
    }

    await this.prisma.accountingAddress.update({
      where: { id: acct.id },
      data: { lastSyncedAt: new Date() },
    });

    this.logger.log(`Synced ${result.count} new transfers for ${acct.address}`);
    return { synced: result.count };
  }

  private async fetchAllTransfers(chain: string, address: string) {
    const transfers = [];
    for (const dir of ['from', 'to'] as const) {
      let pageKey: string | undefined;
      do {
        const res = await this.alchemy.getTokenTransfers(chain, address, dir, MAX_PER_PAGE, pageKey);
        transfers.push(...res.transfers);
        pageKey = res.pageKey;
      } while (pageKey);
    }
    return transfers;
  }

  // ---------------------------------------------------------------------------
  // Transfers
  // ---------------------------------------------------------------------------

  async getTransfers(
    namespaceId: string,
    addressId: string,
    opts: {
      search?: string;
      classification?: string;
      direction?: string;
      showHidden?: boolean;
      skip?: number;
      take?: number;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
    },
  ) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');

    const where: any = { accountingAddressId: addressId };
    if (!opts.showHidden) where.isHidden = false;
    if (opts.direction) where.direction = opts.direction;
    if (opts.classification) where.classification = opts.classification as TransferClassification;

    if (opts.search) {
      const q = opts.search.toLowerCase();
      where.OR = [
        { tokenSymbol: { contains: q, mode: 'insensitive' } },
        { txHash: { contains: q, mode: 'insensitive' } },
        { fromAddress: { contains: q, mode: 'insensitive' } },
        { toAddress: { contains: q, mode: 'insensitive' } },
      ];
    }

    const sortField = opts.sortBy ?? 'timestamp';
    const sortDir = opts.sortDir ?? 'desc';
    const orderBy: any =
      sortField === 'timestamp'
        ? [{ timestamp: sortDir }, { blockNumber: sortDir }, { logIndex: sortDir }]
        : { [sortField]: sortDir };

    const [total, transfers] = await Promise.all([
      this.prisma.accountingTransfer.count({ where }),
      this.prisma.accountingTransfer.findMany({ where, orderBy, skip: opts.skip ?? 0, take: opts.take ?? 50 }),
    ]);

    return { total, transfers };
  }

  async updateTransfer(
    namespaceId: string,
    transferId: string,
    data: { classification?: TransferClassification; isHidden?: boolean; chfValue?: string | null; notes?: string | null },
  ) {
    const transfer = await this.prisma.accountingTransfer.findUnique({
      where: { id: transferId },
      include: { accountingAddress: { select: { namespaceId: true } } },
    });
    if (!transfer || transfer.accountingAddress.namespaceId !== namespaceId) {
      throw new NotFoundException('Transfer not found');
    }

    const patch: typeof data & { chfValueIsEstimate?: boolean } = { ...data };
    if (data.chfValue !== undefined) {
      if (data.chfValue === null) {
        // Cleared by the user — fall back to the daily-rate estimate rather than leaving it blank
        const estimate = await this.estimateChfValue(transfer.tokenSymbol, transfer.amountFormatted, transfer.timestamp);
        patch.chfValue = estimate.chfValue ?? null;
        patch.chfValueIsEstimate = estimate.chfValueIsEstimate;
      } else {
        // Explicitly entered/edited — this is now a confirmed value, not an estimate
        patch.chfValueIsEstimate = false;
      }
    }

    const updated = await this.prisma.accountingTransfer.update({ where: { id: transferId }, data: patch });

    // Keep journal entry in sync whenever classification or chfValue changes
    const newClassification = data.classification ?? transfer.classification;
    if (data.classification !== undefined || data.chfValue !== undefined) {
      if (
        newClassification === TransferClassification.UNCLASSIFIED ||
        newClassification === TransferClassification.SKIPPED
      ) {
        await this.prisma.journalEntry.deleteMany({ where: { transferId } });
      } else {
        await this.upsertJournalEntry(namespaceId, updated);
      }
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Journal entries (private helpers)
  // ---------------------------------------------------------------------------

  private async upsertJournalEntry(namespaceId: string, transfer: any): Promise<void> {
    const accounts = await this.getAccountMap(namespaceId);
    const { debitId, creditId } = await this.resolveTemplate(namespaceId, transfer, accounts);

    if (!debitId || !creditId) {
      this.logger.warn(`No accounts found for journal entry on transfer ${transfer.id}`);
      return;
    }

    const amount = transfer.amountFormatted ?? '0';
    const chf = transfer.chfValue ?? null;

    await this.prisma.journalEntry.upsert({
      where: { transferId: transfer.id },
      create: {
        transferId: transfer.id,
        date: transfer.timestamp ?? transfer.createdAt,
        description: `${transfer.tokenSymbol ?? '?'} ${transfer.direction} — ${transfer.txHash.slice(0, 10)}`,
        lines: {
          create: [
            { accountId: debitId,  type: JournalLineType.DEBIT,  amount, chfAmount: chf, tokenSymbol: transfer.tokenSymbol },
            { accountId: creditId, type: JournalLineType.CREDIT, amount, chfAmount: chf, tokenSymbol: transfer.tokenSymbol },
          ],
        },
      },
      update: {
        date: transfer.timestamp ?? transfer.createdAt,
        description: `${transfer.tokenSymbol ?? '?'} ${transfer.direction} — ${transfer.txHash.slice(0, 10)}`,
        lines: {
          deleteMany: {},
          create: [
            { accountId: debitId,  type: JournalLineType.DEBIT,  amount, chfAmount: chf, tokenSymbol: transfer.tokenSymbol },
            { accountId: creditId, type: JournalLineType.CREDIT, amount, chfAmount: chf, tokenSymbol: transfer.tokenSymbol },
          ],
        },
      },
    });
  }

  private async resolveTemplate(
    namespaceId: string,
    transfer: { classification: TransferClassification; direction: string },
    accountMap: Map<string, string>,
  ): Promise<{ debitId: string | undefined; creditId: string | undefined }> {
    // Prefer direction-specific namespace override, fall back to ANY, then hardcoded defaults
    const [specificRow, anyRow] = await Promise.all([
      this.prisma.classificationTemplate.findFirst({
        where: { namespaceId, classification: transfer.classification, direction: transfer.direction },
      }),
      this.prisma.classificationTemplate.findFirst({
        where: { namespaceId, classification: transfer.classification, direction: 'ANY' },
      }),
    ]);
    const dbRow = specificRow ?? anyRow;

    if (dbRow) {
      return { debitId: dbRow.debitAccountId, creditId: dbRow.creditAccountId };
    }

    const dirKey = `${transfer.classification}:${transfer.direction}`;
    const anyKey = `${transfer.classification}:ANY`;
    const tmpl = DEFAULT_TEMPLATES[dirKey] ?? DEFAULT_TEMPLATES[anyKey];

    if (!tmpl) return { debitId: undefined, creditId: undefined };
    return {
      debitId:  accountMap.get(tmpl.debit),
      creditId: accountMap.get(tmpl.credit),
    };
  }

  // ---------------------------------------------------------------------------
  // Chart of accounts
  // ---------------------------------------------------------------------------

  async getAccounts(namespaceId: string) {
    await this.ensureDefaultAccounts(namespaceId);
    return this.prisma.accountingAccount.findMany({
      where: { namespaceId },
      orderBy: [{ type: 'asc' }, { code: 'asc' }, { name: 'asc' }],
    });
  }

  async createAccount(
    namespaceId: string,
    data: { name: string; code?: string; type: AccountType; normalBalance: NormalBalance; description?: string },
  ) {
    return this.prisma.accountingAccount.create({ data: { namespaceId, ...data } });
  }

  async updateAccount(
    namespaceId: string,
    id: string,
    data: { name?: string; code?: string; description?: string },
  ) {
    const row = await this.prisma.accountingAccount.findFirst({ where: { id, namespaceId } });
    if (!row) throw new NotFoundException('Account not found');
    return this.prisma.accountingAccount.update({ where: { id }, data });
  }

  async deleteAccount(namespaceId: string, id: string) {
    const row = await this.prisma.accountingAccount.findFirst({ where: { id, namespaceId } });
    if (!row) throw new NotFoundException('Account not found');
    const usedBy = await this.prisma.journalLine.count({ where: { accountId: id } });
    if (usedBy > 0) throw new ConflictException('Account has journal entries and cannot be deleted');
    await this.prisma.accountingAccount.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Classification templates
  // ---------------------------------------------------------------------------

  async getTemplates(namespaceId: string) {
    await this.ensureDefaultAccounts(namespaceId);
    const userTemplates = await this.prisma.classificationTemplate.findMany({
      where: { namespaceId },
      include: { debitAccount: true, creditAccount: true },
      orderBy: [{ classification: 'asc' }, { direction: 'asc' }],
    });

    // Merge with hardcoded defaults so the UI always shows all rows
    const accountMap = await this.getAccountMap(namespaceId);
    const reverseMap = new Map(Array.from(accountMap.entries()).map(([name, id]) => [id, name]));

    const result = Object.entries(DEFAULT_TEMPLATES).map(([key, defaults]) => {
      const [classification, direction] = key.split(':') as [TransferClassification, string];
      const override = userTemplates.find(
        t => t.classification === classification && t.direction === direction,
      );
      return {
        classification,
        direction,
        debitAccountId:   override?.debitAccountId  ?? accountMap.get(defaults.debit),
        creditAccountId:  override?.creditAccountId ?? accountMap.get(defaults.credit),
        debitAccountName: override ? reverseMap.get(override.debitAccountId)  : defaults.debit,
        creditAccountName: override ? reverseMap.get(override.creditAccountId) : defaults.credit,
        isOverridden: !!override,
        id: override?.id,
      };
    });

    return result;
  }

  async upsertTemplate(
    namespaceId: string,
    data: {
      classification: TransferClassification;
      direction: string;
      debitAccountId: string;
      creditAccountId: string;
    },
  ) {
    // Verify both accounts belong to this namespace
    const [debit, credit] = await Promise.all([
      this.prisma.accountingAccount.findFirst({ where: { id: data.debitAccountId, namespaceId } }),
      this.prisma.accountingAccount.findFirst({ where: { id: data.creditAccountId, namespaceId } }),
    ]);
    if (!debit || !credit) throw new NotFoundException('Account not found');

    return this.prisma.classificationTemplate.upsert({
      where: { namespaceId_classification_direction: { namespaceId, classification: data.classification, direction: data.direction } },
      create: { namespaceId, ...data },
      update: { debitAccountId: data.debitAccountId, creditAccountId: data.creditAccountId },
    });
  }

  async deleteTemplate(namespaceId: string, id: string) {
    const row = await this.prisma.classificationTemplate.findFirst({ where: { id, namespaceId } });
    if (!row) throw new NotFoundException('Template not found');
    await this.prisma.classificationTemplate.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Trial balance
  // ---------------------------------------------------------------------------

  async getTrialBalance(namespaceId: string, addressId?: string) {
    await this.ensureDefaultAccounts(namespaceId);

    const accounts = await this.prisma.accountingAccount.findMany({
      where: { namespaceId },
      orderBy: [{ type: 'asc' }, { code: 'asc' }, { name: 'asc' }],
    });

    const lines = await this.prisma.journalLine.findMany({
      where: {
        journalEntry: {
          transfer: {
            accountingAddress: {
              namespaceId,
              ...(addressId ? { id: addressId } : {}),
            },
          },
        },
      },
      select: { accountId: true, type: true, amount: true, chfAmount: true },
    });

    const totals = new Map<string, { debit: number; credit: number; chfDebit: number; chfCredit: number }>();

    for (const line of lines) {
      if (!totals.has(line.accountId)) {
        totals.set(line.accountId, { debit: 0, credit: 0, chfDebit: 0, chfCredit: 0 });
      }
      const t = totals.get(line.accountId)!;
      const amt = parseFloat(line.amount) || 0;
      const chf = parseFloat(line.chfAmount ?? '0') || 0;
      if (line.type === JournalLineType.DEBIT)  { t.debit  += amt; t.chfDebit  += chf; }
      else                                       { t.credit += amt; t.chfCredit += chf; }
    }

    return accounts.map(acc => {
      const t = totals.get(acc.id) ?? { debit: 0, credit: 0, chfDebit: 0, chfCredit: 0 };
      const net    = acc.normalBalance === NormalBalance.DEBIT ? t.debit - t.credit   : t.credit - t.debit;
      const chfNet = acc.normalBalance === NormalBalance.DEBIT ? t.chfDebit - t.chfCredit : t.chfCredit - t.chfDebit;
      return { ...acc, ...t, net, chfNet };
    });
  }

  // ---------------------------------------------------------------------------
  // Journal entries (for display)
  // ---------------------------------------------------------------------------

  async getJournalEntries(namespaceId: string, addressId: string) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');

    return this.prisma.journalEntry.findMany({
      where: { transfer: { accountingAddressId: addressId } },
      include: {
        lines: { include: { account: true } },
        transfer: { select: { tokenSymbol: true, direction: true, txHash: true, classification: true } },
      },
      orderBy: { date: 'desc' },
    });
  }

  // ---------------------------------------------------------------------------
  // Token balances — per-token IN/OUT/balance aggregation
  // ---------------------------------------------------------------------------

  async getTokenBalances(namespaceId: string, addressId: string) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');

    const transfers = await this.prisma.accountingTransfer.findMany({
      where: { accountingAddressId: addressId, isHidden: false },
      select: {
        tokenSymbol: true,
        tokenAddress: true,
        tokenType: true,
        direction: true,
        amountFormatted: true,
        classification: true,
        chfValue: true,
      },
    });

    type TokenKey = string;
    const map = new Map<TokenKey, {
      tokenSymbol: string | null;
      tokenAddress: string | null;
      tokenType: string;
      totalIn: number;
      totalOut: number;
      chfTotal: number;
      byClassification: Record<string, number>;
      inCount: number;
      outCount: number;
    }>();

    for (const t of transfers) {
      const key: TokenKey = `${t.tokenAddress ?? '__native__'}:${t.tokenSymbol ?? ''}`;
      if (!map.has(key)) {
        map.set(key, {
          tokenSymbol: t.tokenSymbol,
          tokenAddress: t.tokenAddress,
          tokenType: t.tokenType,
          totalIn: 0,
          totalOut: 0,
          chfTotal: 0,
          byClassification: {},
          inCount: 0,
          outCount: 0,
        });
      }
      const entry = map.get(key)!;
      const amount = parseFloat(t.amountFormatted ?? '0') || 0;
      const chf = parseFloat(t.chfValue ?? '0') || 0;

      if (t.direction === 'IN') {
        entry.totalIn += amount;
        entry.inCount += 1;
      } else {
        entry.totalOut += amount;
        entry.outCount += 1;
      }
      entry.chfTotal += chf;
      entry.byClassification[t.classification] = (entry.byClassification[t.classification] ?? 0) + amount;
    }

    return {
      address: acct,
      tokens: Array.from(map.values())
        .map(t => ({ ...t, balance: t.totalIn - t.totalOut }))
        .sort((a, b) => Math.abs(b.totalIn + b.totalOut) - Math.abs(a.totalIn + a.totalOut)),
    };
  }

  // ---------------------------------------------------------------------------
  // Token overview — per-token asset/liability/net + per-classification totals
  // ---------------------------------------------------------------------------

  async getTokenOverview(namespaceId: string, addressId: string, year?: number, quarter?: number) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');

    // Overview always accumulates from the beginning up to the END of the selected period
    let timestampFilter: { lt: Date } | undefined;
    if (year && quarter) {
      const endMonth = quarter * 3 + 1;
      timestampFilter = {
        lt: endMonth > 12
          ? new Date(`${year + 1}-01-01T00:00:00.000Z`)
          : new Date(`${year}-${String(endMonth).padStart(2, '0')}-01T00:00:00.000Z`),
      };
    } else if (year) {
      timestampFilter = {
        lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
      };
    }

    const transfers = await this.prisma.accountingTransfer.findMany({
      where: { accountingAddressId: addressId, isHidden: false, ...(timestampFilter ? { timestamp: timestampFilter } : {}) },
      select: {
        tokenSymbol: true,
        tokenAddress: true,
        direction: true,
        amountFormatted: true,
        classification: true,
        chfValue: true,
      },
    });

    // Classifications that affect assets (signed by direction)
    const ASSET_EFFECT = new Set<TransferClassification>([
      TransferClassification.CAPITAL,
      TransferClassification.INCOME,
      TransferClassification.LOAN,
      TransferClassification.REPAYMENT,
      TransferClassification.SWAP_IN,
      TransferClassification.SWAP_OUT,
      TransferClassification.EXPENSE,
      TransferClassification.PAYMENT,
      // legacy
      TransferClassification.ASSET,
      TransferClassification.RECEIVED,
      TransferClassification.LIABILITY,
    ]);

    // Classifications that also affect liabilities (signed by direction)
    const LIABILITY_EFFECT = new Set<TransferClassification>([
      TransferClassification.LOAN,
      TransferClassification.REPAYMENT,
      // legacy
      TransferClassification.LIABILITY,
    ]);

    // No accounting effect
    const NO_EFFECT = new Set<TransferClassification>([
      TransferClassification.NEUTRAL,
      TransferClassification.SKIPPED,
      TransferClassification.TRANSFER,
    ]);

    type TokenEntry = {
      tokenSymbol: string | null;
      tokenAddress: string | null;
      asset: number;
      liability: number;
      chfAsset: number;
      chfLiability: number;
    };
    type ClassEntry = { count: number; total: number; chfTotal: number };

    const tokenMap = new Map<string, TokenEntry>();
    const classMap = new Map<string, ClassEntry>();
    let unclassifiedCount = 0;

    for (const t of transfers) {
      if (t.classification === TransferClassification.UNCLASSIFIED) {
        unclassifiedCount++;
        continue;
      }
      if (NO_EFFECT.has(t.classification)) continue;

      const amount = parseFloat(t.amountFormatted ?? '0') || 0;
      const chf = parseFloat(t.chfValue ?? '0') || 0;
      const signedAmount = t.direction === 'IN' ? amount : -amount;
      const signedChf = t.direction === 'IN' ? chf : -chf;

      const tokenKey = `${t.tokenAddress ?? '__native__'}:${t.tokenSymbol ?? ''}`;
      if (!tokenMap.has(tokenKey)) {
        tokenMap.set(tokenKey, { tokenSymbol: t.tokenSymbol, tokenAddress: t.tokenAddress, asset: 0, liability: 0, chfAsset: 0, chfLiability: 0 });
      }
      const entry = tokenMap.get(tokenKey)!;

      if (ASSET_EFFECT.has(t.classification)) {
        entry.asset += signedAmount;
        entry.chfAsset += signedChf;
      }
      if (LIABILITY_EFFECT.has(t.classification)) {
        entry.liability += signedAmount;
        entry.chfLiability += signedChf;
      }

      const ce = classMap.get(t.classification) ?? { count: 0, total: 0, chfTotal: 0 };
      ce.count++;
      ce.total += signedAmount;
      ce.chfTotal += signedChf;
      classMap.set(t.classification, ce);
    }

    // Fold manual adjustments into the token map
    const adjustments = await this.prisma.accountingAdjustment.findMany({
      where: { accountingAddressId: addressId, ...(timestampFilter ? { date: timestampFilter } : {}) },
    });

    for (const adj of adjustments) {
      // Merge into an existing token entry matched by symbol; create a new one only if none exists
      const symLower = adj.tokenSymbol?.toLowerCase();
      let tokenKey = symLower
        ? [...tokenMap.keys()].find(k => tokenMap.get(k)!.tokenSymbol?.toLowerCase() === symLower)
        : undefined;
      if (!tokenKey) {
        tokenKey = `__adj__:${adj.tokenSymbol ?? '__general__'}`;
        tokenMap.set(tokenKey, { tokenSymbol: adj.tokenSymbol, tokenAddress: null, asset: 0, liability: 0, chfAsset: 0, chfLiability: 0 });
      }
      const entry = tokenMap.get(tokenKey)!;

      const amount = parseFloat(adj.amount ?? '0') || 0;
      const chf = parseFloat(adj.chfValue ?? '0') || 0;

      if (adj.type === 'PROFIT') {
        entry.asset    += amount;
        entry.chfAsset += chf;
      } else if (adj.type === 'LOSS') {
        entry.asset    -= amount;
        entry.chfAsset -= chf;
      } else if (adj.type === 'BORROW') {
        entry.liability    -= amount;
        entry.chfLiability -= chf;
      } else if (adj.type === 'REPAYMENT') {
        entry.liability    += amount;
        entry.chfLiability += chf;
      }

      // Surface in byClassification as INCOME (received) or EXPENSE (sent out)
      const isPositive = adj.type === 'PROFIT' || adj.type === 'BORROW';
      const adjClass = isPositive ? TransferClassification.INCOME : TransferClassification.EXPENSE;
      const adjSign = isPositive ? 1 : -1;
      const ce = classMap.get(adjClass) ?? { count: 0, total: 0, chfTotal: 0 };
      ce.count++;
      ce.total += adj.amount ? adjSign * (parseFloat(adj.amount) || 0) : 0;
      ce.chfTotal += adj.chfValue ? adjSign * (parseFloat(adj.chfValue) || 0) : 0;
      classMap.set(adjClass, ce);
    }

    const tokens = Array.from(tokenMap.values())
      .map(t => ({ ...t, net: t.asset - t.liability, chfNet: t.chfAsset - t.chfLiability }))
      .sort((a, b) => Math.abs(b.chfAsset) - Math.abs(a.chfAsset));

    const byClassification = Array.from(classMap.entries())
      .map(([classification, data]) => ({ classification, ...data }))
      .sort((a, b) => b.total - a.total);

    // Distinct years across all (non-hidden) transfers for this address
    const allTimestamps = await this.prisma.accountingTransfer.findMany({
      where: { accountingAddressId: addressId, isHidden: false, timestamp: { not: null } },
      select: { timestamp: true },
    });
    const years = [...new Set(allTimestamps.map(t => t.timestamp!.getFullYear()))].sort((a, b) => b - a);

    return { address: acct, tokens, byClassification, unclassifiedCount, years };
  }

  // ---------------------------------------------------------------------------
  // Legacy summary (kept for backwards compat)
  // ---------------------------------------------------------------------------

  async getSummary(namespaceId: string, addressId: string) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');
    const tb = await this.getTrialBalance(namespaceId, addressId);
    return { address: acct, trialBalance: tb };
  }

  // ---------------------------------------------------------------------------
  // Blacklist
  // ---------------------------------------------------------------------------

  async getBlacklist() {
    return this.prisma.accountingBlacklist.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async addToBlacklist(userId: string, tokenAddress: string, chainId: number, tokenSymbol?: string, reason?: string) {
    const normalised = tokenAddress.toLowerCase();
    const entry = await this.prisma.accountingBlacklist.upsert({
      where: { tokenAddress_chainId: { tokenAddress: normalised, chainId } },
      create: { tokenAddress: normalised, chainId, tokenSymbol, reason, addedByUserId: userId },
      update: { tokenSymbol, reason },
    });
    await this.prisma.accountingTransfer.updateMany({
      where: { tokenAddress: normalised, chainId },
      data: { isHidden: true },
    });
    return entry;
  }

  async removeFromBlacklist(id: string) {
    const row = await this.prisma.accountingBlacklist.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Blacklist entry not found');
    await this.prisma.accountingBlacklist.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async getAccountMap(namespaceId: string): Promise<Map<string, string>> {
    const accounts = await this.prisma.accountingAccount.findMany({
      where: { namespaceId },
      select: { id: true, name: true },
    });
    return new Map(accounts.map(a => [a.name, a.id]));
  }

  private async ensureDefaultAccounts(namespaceId: string): Promise<void> {
    const count = await this.prisma.accountingAccount.count({ where: { namespaceId } });
    if (count > 0) return;

    await this.prisma.accountingAccount.createMany({
      data: DEFAULT_ACCOUNTS.map(a => ({ ...a, namespaceId })),
      skipDuplicates: true,
    });
  }

  // ---------------------------------------------------------------------------
  // Counterparty labels (global per user — address → friendly name)
  // ---------------------------------------------------------------------------

  async getCounterpartyLabels(namespaceId: string): Promise<Record<string, string>> {
    const rows = await this.prisma.accountingCounterpartyLabel.findMany({ where: { namespaceId } });
    return Object.fromEntries(rows.map(r => [r.address, r.label]));
  }

  async upsertCounterpartyLabel(namespaceId: string, address: string, label: string | null) {
    const normalised = address.toLowerCase();
    if (!label) {
      await this.prisma.accountingCounterpartyLabel.deleteMany({ where: { namespaceId, address: normalised } });
      return null;
    }
    return this.prisma.accountingCounterpartyLabel.upsert({
      where: { namespaceId_address: { namespaceId, address: normalised } },
      create: { namespaceId, address: normalised, label },
      update: { label },
    });
  }

  // ---------------------------------------------------------------------------
  // Token year-end prices (user-entered, per address + year)
  // ---------------------------------------------------------------------------

  async getTokenPrices(namespaceId: string, addressId: string, year: number): Promise<Record<string, string>> {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');
    const rows = await this.prisma.accountingTokenPrice.findMany({ where: { accountingAddressId: addressId, year } });
    return Object.fromEntries(rows.map(r => [r.tokenSymbol, r.priceChf]));
  }

  async upsertTokenPrice(namespaceId: string, addressId: string, year: number, tokenSymbol: string, priceChf: string | null) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');
    if (!priceChf) {
      await this.prisma.accountingTokenPrice.deleteMany({ where: { accountingAddressId: addressId, year, tokenSymbol } });
      return null;
    }
    return this.prisma.accountingTokenPrice.upsert({
      where: { accountingAddressId_year_tokenSymbol: { accountingAddressId: addressId, year, tokenSymbol } },
      create: { accountingAddressId: addressId, year, tokenSymbol, priceChf },
      update: { priceChf },
    });
  }

  // ---------------------------------------------------------------------------
  // Adjustments (manual corrections / profit / loss entries)
  // ---------------------------------------------------------------------------

  async getAdjustments(namespaceId: string, addressId: string, year?: number, quarter?: number) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');

    let dateFilter: { gte?: Date; lt?: Date } | undefined;
    if (year && quarter) {
      const startMonth = (quarter - 1) * 3 + 1;
      const endMonth = startMonth + 3;
      dateFilter = {
        gte: new Date(`${year}-${String(startMonth).padStart(2, '0')}-01T00:00:00.000Z`),
        lt: endMonth > 12
          ? new Date(`${year + 1}-01-01T00:00:00.000Z`)
          : new Date(`${year}-${String(endMonth).padStart(2, '0')}-01T00:00:00.000Z`),
      };
    } else if (year) {
      dateFilter = {
        gte: new Date(`${year}-01-01T00:00:00.000Z`),
        lt: new Date(`${year + 1}-01-01T00:00:00.000Z`),
      };
    }

    return this.prisma.accountingAdjustment.findMany({
      where: { accountingAddressId: addressId, ...(dateFilter ? { date: dateFilter } : {}) },
      orderBy: { date: 'desc' },
    });
  }

  async createAdjustment(
    namespaceId: string,
    addressId: string,
    body: { date?: string; type: string; tokenSymbol?: string; amount?: string; chfValue?: string; note?: string },
  ) {
    const acct = await this.prisma.accountingAddress.findFirst({ where: { id: addressId, namespaceId } });
    if (!acct) throw new NotFoundException('Address not found');

    return this.prisma.accountingAdjustment.create({
      data: {
        accountingAddressId: addressId,
        date: body.date ? new Date(body.date) : new Date(),
        type: body.type,
        tokenSymbol: body.tokenSymbol ?? null,
        amount: body.amount ?? null,
        chfValue: body.chfValue ?? null,
        note: body.note ?? null,
      },
    });
  }

  async updateAdjustment(
    namespaceId: string,
    id: string,
    body: { date?: string; type?: string; tokenSymbol?: string | null; amount?: string | null; chfValue?: string | null; note?: string | null },
  ) {
    const adj = await this.prisma.accountingAdjustment.findFirst({
      where: { id },
      include: { accountingAddress: true },
    });
    if (!adj || adj.accountingAddress.namespaceId !== namespaceId) throw new NotFoundException('Adjustment not found');

    return this.prisma.accountingAdjustment.update({
      where: { id },
      data: {
        ...(body.date !== undefined ? { date: new Date(body.date) } : {}),
        ...(body.type !== undefined ? { type: body.type } : {}),
        ...(body.tokenSymbol !== undefined ? { tokenSymbol: body.tokenSymbol } : {}),
        ...(body.amount !== undefined ? { amount: body.amount } : {}),
        ...(body.chfValue !== undefined ? { chfValue: body.chfValue } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
      },
    });
  }

  async deleteAdjustment(namespaceId: string, id: string) {
    const adj = await this.prisma.accountingAdjustment.findFirst({
      where: { id },
      include: { accountingAddress: true },
    });
    if (!adj || adj.accountingAddress.namespaceId !== namespaceId) throw new NotFoundException('Adjustment not found');
    await this.prisma.accountingAdjustment.delete({ where: { id } });
  }
}
