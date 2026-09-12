import { CheckIcon, CopySimpleIcon } from "@phosphor-icons/react/ssr";
import { AGENT_SETUP_PROMPT } from "@/lib/site";

export function AgentSetup({ manualHref = "/install/#manual-install" }) {
  return (
    <div className="agent-setup" data-agent-setup>
      <div className="hero-actions agent-setup-actions">
        <button className="button primary agent-setup-button" type="button" data-copy-command={AGENT_SETUP_PROMPT} data-copy-label="Onboard your agent" data-copy-success-label="Setup prompt copied" data-copied="false">
          <CopySimpleIcon className="copy-icon" size={22} aria-hidden="true" />
          <CheckIcon className="copy-success-icon" size={22} weight="bold" aria-hidden="true" />
          <span data-copy-feedback aria-live="polite">Onboard your agent</span>
        </button>
        <a className="agent-manual-link" href={manualHref}>Install manually <span aria-hidden="true">↗</span></a>
      </div>
      <p className="agent-setup-note">Copy the setup prompt, then paste it into your coding agent.</p>
      <details className="agent-copy-fallback" data-copy-fallback hidden>
        <summary>Copy the setup prompt manually</summary>
        <textarea aria-label="Setup prompt to copy" readOnly defaultValue={AGENT_SETUP_PROMPT} rows={5} />
      </details>
    </div>
  );
}
