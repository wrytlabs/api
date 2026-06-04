/**
 * Scans all Morpho Blue markets on Base chain and surfaces at-risk / liquidatable positions.
 *
 * Usage:
 *   yarn script:morpho-scan-base
 *   yarn script:morpho-scan-base --hf 1.05     # custom health factor threshold (default 1.10)
 *   yarn script:morpho-scan-base --limit 20    # positions per market (default 5)
 */

const MORPHO_API = 'https://blue-api.morpho.org/graphql';
const BASE_CHAIN_ID = 8453;

const DEFAULT_HF_THRESHOLD = 1.1;
const DEFAULT_LIMIT = 5;

interface Market {
	uniqueKey: string;
	lltv: string;
	loanAsset: { symbol: string; decimals: number };
	collateralAsset: { symbol: string; decimals: number } | null;
	state: {
		supplyAssetsUsd: number;
		borrowAssetsUsd: number;
		utilization: number;
	};
}

interface Position {
	user: { address: string };
	borrowAssetsUsd: number;
	collateralUsd: number;
	healthFactor: number | null;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
	const res = await fetch(MORPHO_API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables }),
	});
	const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
	if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join(', '));
	if (!json.data) throw new Error('No data returned');
	return json.data;
}

async function fetchAllMarkets(): Promise<Market[]> {
	const query = `
    query BaseMarkets($chainId: Int!) {
      markets(
        first: 100
        orderBy: SupplyAssetsUsd
        orderDirection: Desc
        where: { chainId_in: [$chainId], supplyAssetsUsd_gte: 100000 }
      ) {
        items {
          uniqueKey
          lltv
          loanAsset { symbol decimals }
          collateralAsset { symbol decimals }
          state { supplyAssetsUsd borrowAssetsUsd utilization }
        }
      }
    }
  `;
	const { markets } = await gql<{ markets: { items: Market[] } }>(query, { chainId: BASE_CHAIN_ID });
	return markets.items;
}

async function fetchRiskyPositions(marketUniqueKey: string, limit: number, hfThreshold: number): Promise<Position[]> {
	const query = `
    query RiskyPositions($marketUniqueKey: String!, $limit: Int!) {
      marketPositions(
        first: $limit
        orderBy: HealthFactor
        orderDirection: Asc
        where: {
          marketUniqueKey_in: [$marketUniqueKey]
          borrowShares_gte: "1"
          healthFactor_lte: ${hfThreshold}
        }
      ) {
        items {
          user { address }
          borrowAssetsUsd
          collateralUsd
          healthFactor
        }
      }
    }
  `;
	const { marketPositions } = await gql<{ marketPositions: { items: Position[] } }>(query, {
		marketUniqueKey,
		limit,
	});
	return marketPositions.items;
}

function fmtUsd(v: number | null | undefined): string {
	if (v == null) return 'N/A';
	return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(v: number): string {
	return `${(v * 100).toFixed(1)}%`;
}

function hfColor(hf: number | null): string {
	if (hf == null) return 'N/A     ';
	const s = hf.toFixed(4);
	if (hf < 1.0) return `${s} 🔴 LIQUIDATABLE`;
	if (hf < 1.05) return `${s} 🟠 CRITICAL`;
	if (hf < 1.1) return `${s} 🟡 DANGER`;
	return `${s} ⚠ AT RISK`;
}

async function main() {
	const args = process.argv.slice(2);
	const hfIdx = args.indexOf('--hf');
	const limIdx = args.indexOf('--limit');
	const hfThreshold = hfIdx >= 0 ? parseFloat(args[hfIdx + 1]) : DEFAULT_HF_THRESHOLD;
	const limit = limIdx >= 0 ? parseInt(args[limIdx + 1]) : DEFAULT_LIMIT;

	console.log(`\nMorpho Blue — Base Chain Position Scanner`);
	console.log(`Health factor threshold: ≤ ${hfThreshold}  |  Top ${limit} positions per market\n`);

	const markets = await fetchAllMarkets();
	console.log(`Found ${markets.length} markets with >$100K TVL on Base\n`);

	let totalAtRisk = 0;
	let totalLiquidatable = 0;
	let totalExposureUsd = 0;

	for (const market of markets) {
		const collSym = market.collateralAsset?.symbol ?? 'N/A';
		const loanSym = market.loanAsset.symbol;
		const lltv = parseFloat(market.lltv) / 1e18;

		const positions = await fetchRiskyPositions(market.uniqueKey, limit, hfThreshold);

		if (positions.length === 0) continue;

		const liquidatable = positions.filter((p) => p.healthFactor != null && p.healthFactor < 1.0);
		totalAtRisk += positions.length;
		totalLiquidatable += liquidatable.length;
		totalExposureUsd += positions.reduce((sum, p) => sum + p.borrowAssetsUsd, 0);

		console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
		console.log(`  ${collSym} / ${loanSym}  |  LLTV ${fmtPct(lltv)}  |  TVL ${fmtUsd(market.state.supplyAssetsUsd)}  |  Util ${fmtPct(market.state.utilization)}`);
		console.log(`  ${market.uniqueKey}`);
		console.log(`  ─────────────────────────────────────────────────────────────────────────`);
		console.log(`  ${'Health Factor'.padEnd(28)} ${'Borrower'.padEnd(44)} ${'Borrow'.padStart(12)} ${'Collateral'.padStart(12)}`);
		console.log(`  ${'─'.repeat(28)} ${'─'.repeat(44)} ${'─'.repeat(12)} ${'─'.repeat(12)}`);

		for (const pos of positions) {
			const hf = hfColor(pos.healthFactor);
			console.log(`  ${hf.padEnd(28)} ${pos.user.address.padEnd(44)} ${fmtUsd(pos.borrowAssetsUsd).padStart(12)} ${fmtUsd(pos.collateralUsd).padStart(12)}`);
		}
	}

	console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
	console.log(`  SUMMARY`);
	console.log(`  At-risk positions (HF ≤ ${hfThreshold}): ${totalAtRisk}`);
	console.log(`  Liquidatable now  (HF < 1.0):  ${totalLiquidatable} 🔴`);
	console.log(`  Total borrow exposure:          ${fmtUsd(totalExposureUsd)}`);
	console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch((err) => {
	console.error('Error:', err.message);
	process.exit(1);
});
