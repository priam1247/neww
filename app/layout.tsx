import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import './globals.css';

export const metadata: Metadata = {
  title: 'ZaFar Control Room — Bot Operations & Access Desk',
  description:
    'Approve WhatsApp operators, issue short-lived linking codes, inspect live socket telemetry, and explore ZaFar Bot media and past-paper capabilities.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} dark`}
    >
      <body className="min-h-screen bg-obsidian-900 font-sans text-[#f4f7fb] selection:bg-mint selection:text-[#071510]">
        {children}
      </body>
    </html>
  );
}
