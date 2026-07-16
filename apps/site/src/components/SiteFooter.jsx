import { GITHUB_URL } from "@/lib/site";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p>Preflight Scout runs checks and writes the evidence. You still merge, deploy, and decide whether to ship.</p>
      <nav aria-label="Footer navigation">
        <a href="/install/">Install</a>
        <a href="/security/">Security</a>
        <a href="/licenses/fonts-OFL.txt">Font license</a>
        <a href="/licenses/phosphor-MIT.txt">Icon license</a>
        <a href={GITHUB_URL}>GitHub</a>
      </nav>
      <p>Built by <a href="https://github.com/anfen93">Andrea Fenu</a> at <a href="https://fenutech.com">Fenutech</a>.</p>
    </footer>
  );
}
