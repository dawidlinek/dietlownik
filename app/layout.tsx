import type { Metadata } from "next";
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";

import "./globals.css";

const fraunces = Fraunces({
  axes: ["SOFT", "opsz"],
  display: "swap",
  subsets: ["latin", "latin-ext"],
  variable: "--font-fraunces",
  weight: "variable",
});

const jakarta = Plus_Jakarta_Sans({
  display: "swap",
  subsets: ["latin", "latin-ext"],
  variable: "--font-jakarta",
  weight: "variable",
});

export const metadata: Metadata = {
  description:
    "Porównywarka cen cateringów dietetycznych — Wrocław, dane z dietly.pl.",
  title: "dietlownik",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pl"
      className={`${fraunces.variable} ${jakarta.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-[var(--color-cream)] text-[var(--color-ink)] flex flex-col">
        {children}
      </body>
    </html>
  );
}
