import { CloudArrowUpIcon, EyeIcon, GlobeHemisphereWestIcon, KeyIcon, ShieldCheckIcon } from "@phosphor-icons/react/ssr";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Security and Data Boundaries",
  description: "Learn what Preflight Scout reads, sends to the selected model, stores locally, and blocks during browser checks.",
  path: "/security/"
});

const boundaries = [
  {
    title: "Local evidence",
    body: "Reports and browser artifacts stay in the repository run directory unless you explicitly upload them through CI.",
    icon: EyeIcon
  },
  {
    title: "Dedicated credentials",
    body: "Browser missions receive only the exact role credentials named in the reviewed configuration. Provider and infrastructure secrets are rejected.",
    icon: KeyIcon
  },
  {
    title: "One reviewed origin",
    body: "The built-in browser runner stays on the exact HTTP(S) origin approved for the mission and blocks off-origin or local-file navigation.",
    icon: GlobeHemisphereWestIcon
  },
  {
    title: "Human release control",
    body: "Preflight Scout proposes checks and records evidence. It does not turn a passing mission into an automatic production decision.",
    icon: ShieldCheckIcon
  },
  {
    title: "What the model receives",
    body: "Preflight Scout sends the reviewed diff and limited repository context to the provider or local agent you choose. Secret values are redacted. Local evidence storage does not make model calls offline.",
    icon: CloudArrowUpIcon
  }
];

export default function SecurityPage() {
  return (
    <div className="subpage">
      <header className="subpage-intro">
        <p className="eyebrow">SECURITY / FAIL CLOSED</p>
        <h1>What Preflight Scout reads, sends, stores, and blocks.</h1>
        <p>Use Preflight Scout against local, preview, or staging environments. The built-in Playwright runner enforces the rules below. External agents and custom commands do not; they use their own browser, filesystem, and network permissions.</p>
      </header>
      <div className="security-grid">
        {boundaries.map((boundary, index) => {
          const Icon = boundary.icon;
          return (
            <article className="security-card" key={boundary.title}>
              <div className="security-card-top"><span>0{index + 1}</span><Icon size={44} weight="thin" aria-hidden="true" /></div>
              <h2>{boundary.title}</h2>
              <p>{boundary.body}</p>
            </article>
          );
        })}
      </div>
      <section className="security-disclosure">
        <p className="eyebrow">RESPONSIBLE DISCLOSURE</p>
        <h2>Do not post vulnerabilities or exposed credentials in a public issue.</h2>
        <p>Use the private reporting path described in the repository’s <a href="https://github.com/fenutech/preflight-scout/security/policy">security policy</a>. Include the affected version, impact, reproduction steps, and any mitigations you have already tried.</p>
      </section>
    </div>
  );
}
