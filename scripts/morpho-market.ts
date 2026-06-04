/**
 * Fetches and displays the top N Morpho Blue markets with positions near liquidation.
 *
 * Usage:
 *   yarn script:morpho-market
 *   yarn script:morpho-market <marketUniqueKey>
 *
 * Example:
 *   yarn script:morpho-market b8db...
 */

const MORPHO_API = 'https://blue-api.morpho.org/graphql';
const TOP_MARKETS = 10;
const DANGER_HF = 1.01; // positions within 1% of liquidation

const MARKET_FIELDS = `
  marketId
  lltv
  state {
    supplyAssets
    supplyAssetsUsd
    borrowAssets
    borrowAssetsUsd
    utilization
    liquidityAssets
    liquidityAssetsUsd
  }
  loanAsset { symbol decimals }
  collateralAsset { symbol decimals }
  oracle { address }
  badDebt { underlying usd }
`;

const TOP_MARKETS_QUERY = `
  query ListTopMarkets($first: Int!) {
    markets(first: $first, orderBy: SupplyAssetsUsd, orderDirection: Desc, where: { chainId_in: [1] }) {
      items {
        ${MARKET_FIELDS}
      }
    }
  }
`;

const MARKET_BY_KEY_QUERY = `
  query GetMarket($uniqueKey: String!) {
    markets(first: 1, where: { uniqueKey_in: [$uniqueKey] }) {
      items {
        ${MARKET_FIELDS}
      }
    }
  }
`;

const POSITIONS_QUERY = `
  query GetPositions($marketUniqueKey: String!, $healthFactorLte: Float) {
    marketPositions(
      first: 10
      orderBy: HealthFactor
      orderDirection: Asc
      where: { marketUniqueKey_in: [$marketUniqueKey], borrowShares_gte: "1", healthFactor_lte: $healthFactorLte }
    ) {
      items {
        user { address }
        healthFactor
        state {
          borrowAssets
          borrowAssetsUsd
          collateral
          collateralUsd
        }
      }
    }
  }
`;

interface MarketItem {
	marketId: string;
	lltv: string;
	state: {
		supplyAssets: string;
		supplyAssetsUsd: number;
		borrowAssets: string;
		borrowAssetsUsd: number;
		utilization: number;
		liquidityAssets: string;
		liquidityAssetsUsd: number;
	};
	loanAsset: { symbol: string; decimals: number };
	collateralAsset: { symbol: string; decimals: number } | null;
	oracle: { address: string } | null;
	badDebt: { underlying: string; usd: number } | null;
}

interface PositionItem {
	user: { address: string };
	healthFactor: number | null;
	state: {
		borrowAssets: string;
		borrowAssetsUsd: number;
		collateral: string;
		collateralUsd: number;
	} | null;
}

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
	const res = await fetch(MORPHO_API, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables }),
	});

	const json = (await res.json()) as { data?: T; errors?: { message: string }[] };

	if (json.errors?.length) {
		throw new Error(json.errors.map((e) => e.message).join(', '));
	}
	if (!json.data) throw new Error('No data returned from Morpho API');

	return json.data;
}

function fmt(value: string | number | null | undefined, decimals = 6): string {
	if (value == null) return 'N/A';
	const raw = typeof value === 'string' ? parseFloat(value) : value;
	const n = raw / 10 ** decimals;
	return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function fmtUsd(value: number | null | undefined): string {
	if (value == null) return 'N/A';
	return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(value: number | null | undefined): string {
	if (value == null) return 'N/A';
	return `${(value * 100).toFixed(2)}%`;
}

function healthLabel(hf: number | null): string {
	if (hf == null) return '';
	if (hf < 1) return ' ⚠ LIQUIDATABLE';
	if (hf < 1.005) return ' ⚡ CRITICAL';
	return ' ⚡ DANGER';
}

function printMarket(market: MarketItem, positions: PositionItem[]) {
	const lltv = parseFloat(market.lltv) / 1e18;
	const collSym = market.collateralAsset?.symbol ?? 'N/A';
	const loanSym = market.loanAsset.symbol;
	const loanDec = market.loanAsset.decimals;

	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  MARKET: ${collSym} / ${loanSym}`);
	console.log(`  Key:    ${market.marketId}`);
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  LLTV:        ${fmtPct(lltv)}`);
	console.log(`  Oracle:      ${market.oracle?.address ?? 'N/A'}`);
	console.log('');
	console.log(`  Supply:      ${fmt(market.state.supplyAssets, loanDec)} ${loanSym}  (${fmtUsd(market.state.supplyAssetsUsd)})`);
	console.log(`  Borrow:      ${fmt(market.state.borrowAssets, loanDec)} ${loanSym}  (${fmtUsd(market.state.borrowAssetsUsd)})`);
	console.log(`  Liquidity:   ${fmt(market.state.liquidityAssets, loanDec)} ${loanSym}  (${fmtUsd(market.state.liquidityAssetsUsd)})`);
	console.log(`  Utilization: ${fmtPct(market.state.utilization)}`);

	if (market.badDebt?.usd) {
		console.log(`  Bad Debt:    ${fmtUsd(market.badDebt.usd)} ⚠`);
	}

	console.log('');
	console.log(`  POSITIONS WITHIN 1% OF LIQUIDATION (HF ≤ ${DANGER_HF})`);
	console.log('  ─────────────────────────────────────────────────────────');

	if (positions.length === 0) {
		console.log('  None.');
	} else {
		const hfWidth = 8;
		const addrWidth = 44;
		console.log(
			`  ${'Health'.padEnd(hfWidth)} ${'Borrower'.padEnd(addrWidth)} ${'Borrow (USD)'.padStart(14)} ${'Collateral (USD)'.padStart(16)}`,
		);
		console.log(`  ${'─'.repeat(hfWidth)} ${'─'.repeat(addrWidth)} ${'─'.repeat(14)} ${'─'.repeat(16)}`);

		for (const pos of positions) {
			const hf = pos.healthFactor != null ? pos.healthFactor.toFixed(4) : 'N/A';
			const label = healthLabel(pos.healthFactor);
			console.log(
				`  ${hf.padEnd(hfWidth)} ${pos.user.address.padEnd(addrWidth)} ${fmtUsd(pos.state?.borrowAssetsUsd).padStart(14)} ${fmtUsd(pos.state?.collateralUsd).padStart(16)}${label}`,
			);
		}
	}

	console.log('');
}

async function main() {
	const marketKey = process.argv[2];

	let markets: MarketItem[];

	if (marketKey) {
		const { markets: result } = await gql<{ markets: { items: MarketItem[] } }>(MARKET_BY_KEY_QUERY, {
			uniqueKey: marketKey,
		});
		if (!result.items.length) throw new Error(`Market not found: ${marketKey}`);
		markets = result.items;
	} else {
		console.log(`Fetching top ${TOP_MARKETS} markets by TVL...\n`);
		const { markets: result } = await gql<{ markets: { items: MarketItem[] } }>(TOP_MARKETS_QUERY, {
			first: TOP_MARKETS,
		});
		markets = result.items;
	}

	// Fetch near-liquidation positions for all markets in parallel
	const positionResults = await Promise.all(
		markets.map((m) =>
			gql<{ marketPositions: { items: PositionItem[] } }>(POSITIONS_QUERY, {
				marketUniqueKey: m.marketId,
				healthFactorLte: DANGER_HF,
			}),
		),
	);

	let totalAtRisk = 0;
	for (let i = 0; i < markets.length; i++) {
		const positions = positionResults[i].marketPositions.items;
		totalAtRisk += positions.length;
		printMarket(markets[i], positions);
	}

	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
	console.log(`  ${markets.length} markets scanned  •  ${totalAtRisk} positions within 1% of liquidation`);
	console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((err) => {
	console.error('Error:', err.message);
	process.exit(1);
});
