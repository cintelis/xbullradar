import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'xBullRadar',
  description: 'Real-time stock & crypto sentiment from X, powered by Grok.',
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
