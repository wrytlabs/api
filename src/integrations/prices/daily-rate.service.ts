import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../core/database/prisma.service';

// Only 2025-onward daily closes are needed — keeps both source calls to a
// single request each (well under Kraken's 720-candle OHLC cap).
const BACKFILL_START = '2025-01-01';

interface DailyClose {
  date: Date;
  close: number;
}

interface FrankfurterTimeseries {
  rates: Record<string, Record<string, number>>;
}

interface KrakenOhlcResponse {
  error: string[];
  result: Record<string, [number, string, string, string, string, string, string, number][] | number>;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Maintains a small daily-close CHF rate table for the reference assets
 * (USD, EUR, BTC, ETH) used to auto-estimate accounting `chfValue`.
 * Fiat comes from Frankfurter (ECB data), crypto from Kraken's public OHLC —
 * both free, keyless, and already within the codebase's trusted sources.
 */
@Injectable()
export class DailyRateService implements OnModuleInit {
  private readonly logger = new Logger(DailyRateService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    this.refreshDailyRates().catch((err) =>
      this.logger.error(`Initial daily rate refresh failed: ${err.message}`),
    );
  }

  // ---------------------------------------------------------------------------
  // Cron: re-fetch the full (small) range daily — simpler and cheap enough than
  // incremental top-ups, and self-heals any gap from a prior failed fetch.
  // ---------------------------------------------------------------------------

  @Cron('0 1 * * *')
  async dailyRefresh(): Promise<void> {
    await this.refreshDailyRates().catch((err) =>
      this.logger.error(`Daily rate refresh failed: ${err.message}`),
    );
  }

  async refreshDailyRates(): Promise<void> {
    const [usd, eur, btc, eth] = await Promise.allSettled([
      this.fetchFrankfurterSeries('USD'),
      this.fetchFrankfurterSeries('EUR'),
      this.fetchKrakenDailyCloses('XBTCHF'),
      this.fetchKrakenDailyCloses('ETHCHF'),
    ]);

    const settled = [
      { base: 'USD', result: usd, source: 'frankfurter' },
      { base: 'EUR', result: eur, source: 'frankfurter' },
      { base: 'BTC', result: btc, source: 'kraken' },
      { base: 'ETH', result: eth, source: 'kraken' },
    ] as const;

    const rows = settled.map(({ base, result, source }) => {
      if (result.status === 'rejected') {
        this.logger.warn(`Daily rate fetch failed for ${base}: ${result.reason?.message}`);
        return { base, closes: [] as DailyClose[], source };
      }
      return { base, closes: result.value, source };
    });

    const upserts = rows.flatMap(({ base, closes, source }) =>
      closes.map(({ date, close }) =>
        this.prisma.dailyRate.upsert({
          where: { date_base: { date, base } },
          create: { date, base, chfClose: close, source },
          update: { chfClose: close, source },
        }),
      ),
    );

    for (const batch of chunk(upserts, 200)) {
      await this.prisma.$transaction(batch);
    }

    this.logger.log(`Daily rates refreshed — ${upserts.length} rows across ${rows.length} series`);
  }

  // ---------------------------------------------------------------------------
  // Lookup
  // ---------------------------------------------------------------------------

  /** Most recent CHF close on or before `date` for `base`. CHF itself is always 1. */
  async getRate(base: string, date: Date): Promise<number | null> {
    const row = await this.getRateRow(base, date);
    return row?.chfClose ?? null;
  }

  /** Same lookup as `getRate`, but returns the full row (date/source included) for API responses. */
  async getRateRow(base: string, date: Date): Promise<{ date: Date; chfClose: number; source: string } | null> {
    if (base === 'CHF') return { date, chfClose: 1, source: 'peg' };
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    return this.prisma.dailyRate.findFirst({
      where: { base, date: { lte: day } },
      orderBy: { date: 'desc' },
    });
  }

  /** Full stored daily-close series for a reference asset, oldest first. */
  async listRates(base: string): Promise<{ date: Date; chfClose: number; source: string }[]> {
    if (base === 'CHF') return [];
    return this.prisma.dailyRate.findMany({ where: { base }, orderBy: { date: 'asc' } });
  }

  // ---------------------------------------------------------------------------
  // Sources
  // ---------------------------------------------------------------------------

  /** ECB daily close rates via Frankfurter — one call covers the whole range. */
  private async fetchFrankfurterSeries(base: 'USD' | 'EUR'): Promise<DailyClose[]> {
    const res = await fetch(`https://api.frankfurter.dev/v1/${BACKFILL_START}..?base=${base}&symbols=CHF`);
    const json: FrankfurterTimeseries = await res.json();
    return Object.entries(json.rates ?? {})
      .map(([date, rates]) => ({ date: new Date(`${date}T00:00:00.000Z`), close: rates.CHF }))
      .filter((r) => isFinite(r.close) && r.close > 0);
  }

  /** Kraken public OHLC — daily candles, no auth required. */
  private async fetchKrakenDailyCloses(pair: string): Promise<DailyClose[]> {
    const since = Math.floor(new Date(`${BACKFILL_START}T00:00:00.000Z`).getTime() / 1000);
    const res = await fetch(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=1440&since=${since}`);
    const json: KrakenOhlcResponse = await res.json();

    if (json.error?.length) {
      this.logger.warn(`Kraken OHLC ${pair} failed: ${json.error.join(', ')}`);
      return [];
    }

    const key = Object.keys(json.result).find((k) => k !== 'last');
    const candles = key ? json.result[key] : undefined;
    if (!Array.isArray(candles)) return [];

    // Drop the last candle — it's the current (possibly incomplete) day, not a settled close.
    return candles
      .slice(0, -1)
      .map(([time, , , , close]) => ({ date: new Date(time * 1000), close: parseFloat(close) }))
      .filter((r) => isFinite(r.close) && r.close > 0);
  }
}
