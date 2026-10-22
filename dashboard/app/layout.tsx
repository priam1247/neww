import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'ZaFar Portal — WhatsApp Bot Access & Admin Console',
  description:
    'Sign in with email to link your WhatsApp number to ZaFar Bot, or manage members and live bot operations from the Admin Console.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen bg-slate-50 font-sans text-slate-900 selection:bg-teal-600 selection:text-white">
        {children}
      </body>
    </html>
  );
}
