import { Address } from 'viem';

export interface EnabledToken {
  symbol: string;
  name: string;
  decimals: number;
  addresses: Partial<Record<number, Address>>;
}

export const ENABLED_TOKENS: EnabledToken[] = [
  {
    symbol: 'USDC',
    name: 'USD Coin',
    decimals: 6,
    addresses: {
      1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    },
  },
  {
    symbol: 'USDT',
    name: 'Tether USD',
    decimals: 6,
    addresses: {
      1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    },
  },
  {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    decimals: 18,
    addresses: {
      1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    },
  },
  {
    symbol: 'WBTC',
    name: 'Wrapped Bitcoin',
    decimals: 8,
    addresses: {
      1: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    },
  },
  {
    symbol: 'ZCHF',
    name: 'Frankencoin',
    decimals: 18,
    addresses: {
      1: '0xB58E61C3098d85632Df34EecfB899A1Ed80921cB',
    },
  },
  {
    symbol: 'cbBTC',
    name: 'Coinbase Wrapped BTC',
    decimals: 8,
    addresses: {
      1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    },
  },
  {
    symbol: 'EURC',
    name: 'Euro Coin',
    decimals: 6,
    addresses: {
      1: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',
    },
  },
];

// ---------------------------------------------------------------------------
// DefiLlama slug map — auto-derived from ENABLED_TOKENS mainnet addresses.
// ETH (native) has no contract so it gets a manual coingecko slug.
// ---------------------------------------------------------------------------

export const TOKEN_SLUGS: Record<string, Partial<Record<string, string>>> = {
  ETH: { defillama: 'coingecko:ethereum' },
  ...Object.fromEntries(
    ENABLED_TOKENS
      .filter((t) => t.addresses[1])
      .map((t) => [t.symbol, { defillama: `ethereum:${t.addresses[1]}` }]),
  ),
};

// ---------------------------------------------------------------------------
// ETH / WETH alias — same asset, wrap/unwrap only. Injected as a 1:1 graph edge.
// ---------------------------------------------------------------------------

export const ETH_WETH_ALIAS = { from: 'ETH', to: 'WETH', value: 1 } as const;

// ---------------------------------------------------------------------------
// Peg config — assets sharing a fiat denomination that can still trade freely.
// The price service resolves the live asset/peg rate and persists it as a
// `derived` rate so callers can observe the current peg deviation.
// ---------------------------------------------------------------------------

export interface PegEntry {
  asset: string;
  peg: string;
}

export const PEG_CONFIG: PegEntry[] = [
  { asset: 'ZCHF', peg: 'CHF' },
  { asset: 'USDC', peg: 'USD' },
  { asset: 'USDT', peg: 'USD' },
  { asset: 'EURC', peg: 'EUR' },
];

// ---------------------------------------------------------------------------
// Daily-rate reference asset map — groups tokens by the underlying asset whose
// CHF daily close rate should be used to auto-estimate accounting chfValue.
// Independent of ENABLED_TOKENS/PEG_CONFIG (which are about swap routing and
// live spot pricing): this only needs to know "what one daily series does this
// symbol need", including tokens with no swap route configured (e.g. USDU).
// ---------------------------------------------------------------------------

export const CHF_RATE_BASE_MAP: Record<string, string> = {
  ZCHF: 'CHF',
  USDC: 'USD',
  USDT: 'USD',
  USDU: 'USD',
  EURC: 'EUR',
  WBTC: 'BTC',
  CBBTC: 'BTC',
  BTC: 'BTC',
  WETH: 'ETH',
  ETH: 'ETH',
};

/** Resolves a token symbol to the reference asset ('CHF'|'USD'|'EUR'|'BTC'|'ETH') whose
 *  daily CHF close rate should be used to estimate its value, or null if unknown
 *  (e.g. governance/pool-share tokens with no natural fiat/crypto peg). */
export function resolveChfRateBase(tokenSymbol: string | null | undefined): string | null {
  if (!tokenSymbol) return null;
  return CHF_RATE_BASE_MAP[tokenSymbol.toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIAT_SYMBOLS = new Set(['USD', 'CHF', 'EUR']);

/** Case-insensitive lookup returning the canonical symbol (e.g. "cbbtc" → "cbBTC"). */
export function resolveSymbol(input: string): string {
  const lower = input.toLowerCase();
  const token = ENABLED_TOKENS.find((t) => t.symbol.toLowerCase() === lower);
  if (token) return token.symbol;
  const upper = input.toUpperCase();
  if (FIAT_SYMBOLS.has(upper)) return upper;
  return upper; // unknown symbol — best-effort uppercase
}

export function getTokenByAddress(address: Address, chainId: number): EnabledToken | undefined {
  return ENABLED_TOKENS.find(
    (token) => token.addresses[chainId]?.toLowerCase() === address.toLowerCase(),
  );
}

export function getEnabledTokenAddresses(chainId: number): Address[] {
  return ENABLED_TOKENS.map((token) => token.addresses[chainId]).filter(
    (address): address is Address => !!address,
  );
}
