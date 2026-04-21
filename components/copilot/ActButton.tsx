'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { OndoAssetData, OndoTokenizedAsset } from '@/types';

interface ActButtonProps {
  asset: OndoTokenizedAsset;
}

function spreadToneClass(premiumPct: number): string {
  const abs = Math.abs(premiumPct);
  if (abs < 0.5) return 'text-zinc-400';
  if (abs < 2) return 'text-amber-400';
  return 'text-red-400';
}

function formatSpread(premiumPct: number): string {
  const label = premiumPct >= 0 ? 'premium' : 'discount';
  const sign = premiumPct > 0 ? '+' : premiumPct < 0 ? '−' : '';
  return `${sign}${Math.abs(premiumPct).toFixed(2)}% ${label}`;
}

export default function ActButton({ asset }: ActButtonProps) {
  const [open, setOpen] = useState(false);
  const [ondoData, setOndoData] = useState<OndoAssetData | null>(null);
  const [loadingPrice, setLoadingPrice] = useState(false);

  const ondoUrl = `https://app.ondo.finance/assets/${asset.ondoSymbol.toLowerCase()}`;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoadingPrice(true);
    setOndoData(null);
    fetch(`/api/ondo/asset?ticker=${encodeURIComponent(asset.ticker)}`, {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) return null;
        return (await res.json()) as OndoAssetData;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setOndoData(data);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setOndoData(null);
      })
      .finally(() => {
        if (controller.signal.aborted) return;
        setLoadingPrice(false);
      });
    return () => controller.abort();
  }, [open, asset.ticker]);

  const handleOpenInOndo = () => {
    window.open(ondoUrl, '_blank', 'noopener,noreferrer');
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="primary" size="lg">
          Act on {asset.ticker}on
          <ArrowRight className="h-4 w-4" />
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take Action — {asset.ticker} Tokenized</DialogTitle>
          <DialogDescription>
            Sentiment Score:{' '}
            <span className="font-semibold text-green-400">
              {asset.sentimentScore.toFixed(2)}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="rounded-xl bg-zinc-900 p-5">
            <p className="mb-1 text-sm text-zinc-400">Tokenized Asset</p>
            <p className="text-3xl font-bold">{asset.ticker}on</p>

            {loadingPrice ? (
              <div className="mt-3 space-y-2">
                <div className="h-5 w-32 animate-pulse rounded bg-zinc-800" />
                <div className="h-4 w-24 animate-pulse rounded bg-zinc-800" />
                <div className="h-4 w-28 animate-pulse rounded bg-zinc-800" />
              </div>
            ) : ondoData ? (
              <div className="mt-3 space-y-1">
                <p className="text-lg font-semibold text-green-400">
                  Tokenized: ${ondoData.tokenPrice.toFixed(2)}
                </p>
                <p className="text-sm text-zinc-400">
                  Stock: ${ondoData.stockPrice.toFixed(2)}
                </p>
                <p className={`text-sm font-medium ${spreadToneClass(ondoData.premiumPct)}`}>
                  {formatSpread(ondoData.premiumPct)}
                </p>
              </div>
            ) : asset.currentPrice !== undefined ? (
              <p className="mt-1 text-green-400">
                Current Price ≈ ${asset.currentPrice}
              </p>
            ) : null}
          </div>

          {asset.reasoning && (
            <p className="text-sm leading-relaxed text-zinc-300">
              {asset.reasoning}
            </p>
          )}

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            onClick={handleOpenInOndo}
          >
            Open in Ondo Global Markets
            <ExternalLink className="ml-2 h-5 w-5" />
          </Button>

          <p className="text-center text-xs text-zinc-500">
            You must be KYC-approved on Ondo to trade. This opens the official Ondo app.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
