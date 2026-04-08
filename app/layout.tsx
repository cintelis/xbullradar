import type { Metadata, Viewport } from 'next';
import './globals.css';

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: {
    default: 'xBullRadar — AI Market Radar · Tokenized RWAs',
    template: '%s · xBullRadar',
  },
  description:
    'Real-time stock and crypto sentiment from X, powered by Grok. Sentiment-aware watchlist with one-click access to tokenized real-world assets.',
  applicationName: 'xBullRadar',
  keywords: [
    'stock sentiment',
    'crypto sentiment',
    'X sentiment',
    'Grok',
    'tokenized RWA',
    'Ondo',
    'AI market radar',
  ],
  authors: [{ name: 'xBullRadar' }],
  // Next.js auto-discovers app/icon.{ico,jpg,png,svg} so the icons block
  // here is for non-default favicon contexts (Apple touch, manifest).
  icons: {
    icon: '/icon.jpg',
    apple: '/icons/icon-512.png',
  },
  manifest: '/manifest.webmanifest',
  openGraph: {
    type: 'website',
    siteName: 'xBullRadar',
    title: 'xBullRadar — AI Market Radar · Tokenized RWAs',
    description:
      'Real-time stock and crypto sentiment from X, powered by Grok. Sentiment-aware watchlist with one-click access to tokenized real-world assets.',
    url: APP_URL,
    images: [
      {
        url: '/og-image.png',
        width: 1201,
        height: 656,
        alt: 'xBullRadar — bull on a sentiment radar with the XR brand mark',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'xBullRadar — AI Market Radar · Tokenized RWAs',
    description:
      'Real-time stock and crypto sentiment from X, powered by Grok.',
    images: ['/og-image.png'],
  },
  robots: {
    // Trial app — keep it out of search engines until launch.
    index: false,
    follow: false,
  },
};

export const viewport: Viewport = {
  themeColor: '#09090b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
