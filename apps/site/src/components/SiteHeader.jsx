import Image from "next/image";
import { ListIcon, XIcon } from "@phosphor-icons/react/ssr";
import { GITHUB_URL, navLinks } from "@/lib/site";

export function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand" href="/" aria-label="Preflight Scout home">
        <Image className="brand-mark" src="/brand/preflight-scout-mark.png" width={58} height={58} alt="" priority />
        <span>Preflight Scout</span>
      </a>
      <button className="menu-button" type="button" data-menu-button aria-expanded="false" aria-controls="site-navigation">
        <ListIcon className="menu-open-icon" size={25} aria-hidden="true" />
        <XIcon className="menu-close-icon" size={25} aria-hidden="true" />
        <span className="sr-only" data-menu-label>Open navigation</span>
      </button>
      <nav id="site-navigation" className="site-nav" aria-label="Primary navigation">
        {navLinks.map((link) => <a key={link.href} href={link.href}>{link.label}</a>)}
        <a href={GITHUB_URL}>GitHub</a>
      </nav>
    </header>
  );
}
