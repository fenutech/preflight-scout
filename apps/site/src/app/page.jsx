import { CircleIcon, DownloadSimpleIcon, GithubLogoIcon } from "@phosphor-icons/react/ssr";
import { CommandLine } from "@/components/CopyCommand";
import { InstrumentReport } from "@/components/InstrumentReport";
import { WorkflowSteps } from "@/components/WorkflowSteps";
import { GITHUB_URL, HOME_STRUCTURED_DATA, RELEASE_VERSION } from "@/lib/site";

const cliCommand = `npm install --global @preflight-scout/cli@${RELEASE_VERSION} --registry=https://registry.npmjs.org/\npreflight-scout install-browser`;
const codexSkillCommand = "codex plugin marketplace add fenutech/preflight-scout\ncodex plugin add preflight-scout@preflight-scout";
const claudeSkillCommand = "claude plugin marketplace add fenutech/preflight-scout\nclaude plugin install preflight-scout@preflight-scout";

export default function HomePage() {
  return (
    <>
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">RELEASE QA FOR CODING AGENTS</p>
          <h1>Give your coding agent a real release check.</h1>
          <p className="hero-lede">Preflight Scout reads the diff, lists affected user flows, runs the browser checks you approve, and saves the evidence for review.</p>
          <div className="hero-actions">
            <a className="button primary" href="/install/"><DownloadSimpleIcon size={28} weight="bold" aria-hidden="true" />Install the alpha</a>
            <a className="button secondary" href={GITHUB_URL}><GithubLogoIcon size={28} weight="fill" aria-hidden="true" />View on GitHub</a>
          </div>
          <div className="trust-line" aria-label="Open source, runs in your repository, you review every result">
            <span>Open source</span><CircleIcon size={7} weight="fill" aria-hidden="true" /><span>Runs in your repository</span><CircleIcon size={7} weight="fill" aria-hidden="true" /><span>You review every result</span>
          </div>
          <ol className="quick-install" aria-label="Quick installation">
            <li>
              <div className="install-step-heading"><span>1</span><strong>Install the CLI</strong></div>
              <CommandLine copyText={cliCommand} multiline>{cliCommand}</CommandLine>
            </li>
            <li>
              <div className="install-step-heading"><span>2</span><strong>Add the agent skill</strong></div>
              <div className="quick-agent-grid">
                <div><strong className="quick-agent-label">Codex</strong><CommandLine copyText={codexSkillCommand} multiline>{codexSkillCommand}</CommandLine></div>
                <div><strong className="quick-agent-label">Claude Code</strong><CommandLine copyText={claudeSkillCommand} multiline>{claudeSkillCommand}</CommandLine></div>
              </div>
              <p>Restart the client and start a new task after installing either plugin. <a href="https://github.com/fenutech/preflight-scout/blob/main/docs/skills.md#direct-codex-installation">Folder installs</a> are in the repository guide.</p>
            </li>
          </ol>
        </div>
        <InstrumentReport compact />
      </section>
      <WorkflowSteps />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(HOME_STRUCTURED_DATA) }} />
    </>
  );
}
