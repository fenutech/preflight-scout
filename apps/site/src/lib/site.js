import sitePackage from "../../package.json";

export const SITE_URL = "https://preflightscout.com";
export const GITHUB_URL = "https://github.com/fenutech/preflight-scout";
export const RELEASE_VERSION = sitePackage.version;

export const HOME_STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://fenutech.com/#organization",
      name: "Fenutech",
      url: "https://fenutech.com/",
      sameAs: ["https://github.com/fenutech"]
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: "Preflight Scout",
      alternateName: "preflightscout.com",
      url: `${SITE_URL}/`,
      description: "Turn a pull-request diff into a test plan, approved browser checks, and reviewable evidence.",
      publisher: { "@id": "https://fenutech.com/#organization" },
      sameAs: [GITHUB_URL]
    }
  ]
};

export const navLinks = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/install/", label: "Install" },
  { href: "/example-report/", label: "Example report" },
  { href: "/security/", label: "Security" }
];

export function pageMetadata({ title, description, path }) {
  const canonical = path === "/" ? "/" : `${path.replace(/\/$/, "")}/`;
  return {
    title,
    description,
    alternates: { canonical },
    openGraph: {
      title,
      description,
      type: "website",
      url: canonical,
      siteName: "Preflight Scout",
      images: [{ url: "/opengraph-image.png", width: 1200, height: 630, alt: "Preflight Scout showing a failed browser check with its evidence" }]
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [{ url: "/opengraph-image.png", alt: "Preflight Scout showing a failed browser check with its evidence" }]
    }
  };
}
