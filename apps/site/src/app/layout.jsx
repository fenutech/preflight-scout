import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@/app/globals.css";
import { SiteFooter } from "@/components/SiteFooter";
import { SiteHeader } from "@/components/SiteHeader";
import { SITE_URL } from "@/lib/site";

export const metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "Preflight Scout",
  title: {
    default: "Preflight Scout — Release QA for coding agents",
    template: "%s — Preflight Scout"
  },
  description: "Preflight Scout turns a pull-request diff into a test plan, approved browser checks, and evidence you can review before shipping.",
  authors: [{ name: "Andrea Fenu", url: "https://github.com/anfen93" }],
  creator: "Andrea Fenu",
  publisher: "Fenutech",
  category: "developer tools",
  alternates: { canonical: "/" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "64x64", type: "image/x-icon" },
      { url: "/brand/preflight-scout-mark.png", sizes: "256x256", type: "image/png" }
    ],
    apple: [{ url: "/brand/preflight-scout-mark.png", type: "image/png" }]
  },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Preflight Scout",
    title: "Preflight Scout — Release QA for coding agents",
    description: "Turn a pull-request diff into a test plan, approved browser checks, and evidence you can review before shipping.",
    images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: "Preflight Scout showing a failed browser check with its evidence" }]
  },
  twitter: {
    card: "summary_large_image",
    title: "Preflight Scout — Release QA for coding agents",
    description: "Turn a pull-request diff into a test plan, approved browser checks, and evidence you can review before shipping.",
    images: [{ url: "/opengraph-image.png", alt: "Preflight Scout showing a failed browser check with its evidence" }]
  }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <body>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="site-shell">
          <SiteHeader />
          <main id="main-content">{children}</main>
          <SiteFooter />
        </div>
        <script src="/site.js" defer />
      </body>
    </html>
  );
}
