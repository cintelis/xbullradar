// Ondo Finance tokenized asset lookup.
//
// Ondo tokenizes US stocks and ETFs as on-chain assets. This module
// provides a static set of which stock tickers are available on Ondo so
// the copilot bot can tell users exactly which of their holdings are
// tradeable there — and construct the right URL.
//
// URL pattern:
//   Direct asset page: https://app.ondo.finance/assets/{ticker}on
//   Search page:       https://app.ondo.finance/?search={ticker}on
//   (ticker lowercased + "on" suffix)
//
// Data sourced from https://app.ondo.finance/ on 2026-04-09. The set
// contains 263 tickers as of that date. Update by re-scraping the page
// or replacing the set contents.

const ONDO_TICKERS: ReadonlySet<string> = new Set([
  'AAL', 'AAPL', 'ABBV', 'ABNB', 'ABT', 'ACHR', 'ACN', 'ADBE', 'ADI', 'AGG',
  'ALB', 'AMAT', 'AMC', 'AMD', 'AMGN', 'AMZN', 'ANET', 'APLD', 'APO', 'APP',
  'ARM', 'ASML', 'ASTS', 'AVGO', 'AXP', 'BA', 'BABA', 'BAC', 'BBAI', 'BIDU',
  'BILI', 'BINC', 'BLK', 'BLSH', 'BMNR', 'BNO', 'BTG', 'BTGO', 'BZ', 'C',
  'CAPR', 'CAT', 'CEG', 'CIBR', 'CIFR', 'CLOA', 'CLOI', 'CMG', 'COF', 'COHR',
  'COIN', 'COP', 'COPX', 'COST', 'CPNG', 'CRCL', 'CRM', 'CRWD', 'CRWV', 'CSCO',
  'CVNA', 'CVX', 'DASH', 'DBC', 'DE', 'DGRW', 'DIS', 'DNN', 'ECH', 'EEM',
  'EFA', 'ENLV', 'ENPH', 'EQIX', 'ETHA', 'ETN', 'EWJ', 'EWY', 'EWZ', 'EXOD',
  'F', 'FCX', 'FFOG', 'FGDL', 'FIG', 'FIGR', 'FLHY', 'FLQL', 'FSOL', 'FTGC',
  'FUTU', 'FXI', 'GE', 'GEMI', 'GEV', 'GLD', 'GLTR', 'GLXY', 'GME', 'GOOGL',
  'GRAB', 'GRND', 'GS', 'HD', 'HIMS', 'HOOD', 'HYG', 'HYS', 'IAU', 'IBIT',
  'IBM', 'IEF', 'IEFA', 'IEMG', 'IJH', 'INCE', 'INDA', 'INTC', 'INTU', 'IONQ',
  'IREN', 'ISRG', 'ITA', 'ITOT', 'IVV', 'IWF', 'IWM', 'IWN', 'JAAA', 'JD',
  'JNJ', 'JPM', 'KLAC', 'KO', 'KWEB', 'LI', 'LIN', 'LLY', 'LMT', 'LOW',
  'LRCX', 'LUNR', 'MA', 'MARA', 'MCD', 'MELI', 'META', 'MP', 'MRK', 'MRNA',
  'MRVL', 'MSFT', 'MSTR', 'MTZ', 'MU', 'NBIS', 'NEE', 'NEM', 'NFLX', 'NIKL',
  'NIO', 'NKE', 'NOC', 'NOW', 'NTES', 'NVDA', 'NVO', 'OIH', 'OKLO', 'ON',
  'ONDS', 'OPEN', 'OPRA', 'ORCL', 'OSCR', 'OXY', 'PALL', 'PANW', 'PAVE', 'PBR',
  'PCG', 'PDBC', 'PDD', 'PEP', 'PFE', 'PG', 'PINS', 'PLTR', 'PLUG', 'PPLT',
  'PSQ', 'PYPL', 'QBTS', 'QCOM', 'QQQ', 'QUBT', 'RDDT', 'RDW', 'REGN', 'REMX',
  'RGTI', 'RIOT', 'RIVN', 'RKLB', 'RTX', 'SBET', 'SBUX', 'SCCO', 'SCHW', 'SEDG',
  'SGOV', 'SHOP', 'SHY', 'SLV', 'SMCI', 'SNAP', 'SNDK', 'SNOW', 'SO', 'SOFI',
  'SOUN', 'SOXX', 'SPGI', 'SPOT', 'SPY', 'SQQQ', 'STX', 'T', 'TCOM', 'TIP',
  'TLN', 'TLT', 'TM', 'TMO', 'TMUS', 'TQQQ', 'TSLA', 'TSM', 'TXN', 'UBER',
  'UEC', 'UNG', 'UNH', 'UNP', 'URA', 'USFR', 'USO', 'V', 'VFS', 'VNQ',
  'VRT', 'VRTX', 'VST', 'VTI', 'VTV', 'VZ', 'WDC', 'WFC', 'WM', 'WMT',
  'WULF', 'XOM', 'XYZ',
]);

/** Check whether a stock ticker is available as a tokenized asset on Ondo. */
export function isOnOndo(ticker: string): boolean {
  return ONDO_TICKERS.has(ticker.toUpperCase());
}

/**
 * Get the direct Ondo asset page URL for a ticker. Returns null if the
 * ticker isn't on Ondo. URL uses the lowercase ticker + "on" convention:
 * MSFT → https://app.ondo.finance/assets/msfton
 */
export function getOndoUrl(ticker: string): string | null {
  const upper = ticker.toUpperCase();
  if (!ONDO_TICKERS.has(upper)) return null;
  return `https://app.ondo.finance/assets/${upper.toLowerCase()}on`;
}

/** Total number of tickers available on Ondo. */
export const ONDO_TICKER_COUNT = ONDO_TICKERS.size;
