import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wiki ingest queue",
  description: "Live status of the obsidian-claude-accenture ingest pipeline.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
