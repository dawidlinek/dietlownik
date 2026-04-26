import type { Metadata } from "next";
import { Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  axes: ["SOFT", "opsz"],
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin", "latin-ext"],
  weight: "variable",
  display: "swap",
});

export const metadata: Metadata = {
  title: "dietlownik",
  description:
    "Porównywarka cen cateringów dietetycznych — Wrocław, dane z dietly.pl.",
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
