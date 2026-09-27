import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const inter = localFont({
  src: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  variable: "--font-inter",
  weight: "100 900",
  style: "normal",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Tayra Labs — Workspace", template: "%s · Tayra Labs" },
  description: "The Tayra Labs video intelligence workspace.",
  icons: { icon: "/tayra-logo.svg" },
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${inter.variable}`}>
      <body className="font-sans">
        {children}
      </body>
    </html>
  );
}
