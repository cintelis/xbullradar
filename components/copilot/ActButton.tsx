'use client';

import { useState } from 'react';
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
import type { OndoTokenizedAsset } from '@/types';

interface ActButtonProps {
  asset: OndoTokenizedAsset;
}

export default function ActButton({ asset }: ActButtonProps) {
  const [open, setOpen] = useState(false);

  const ondoUrl = `https://app.ondo.finance/assets/${asset.ondoSymbol.toLowerCase()}`;

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
            {asset.currentPrice !== undefined && (
              <p className="mt-1 text-green-400">
                Current Price ≈ ${asset.currentPrice}
              </p>
            )}
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
