import { CircleIcon } from "@phosphor-icons/react/ssr";
import { AgentSetup } from "@/components/AgentSetup";
import { CommandLine } from "@/components/CopyCommand";
import { InstrumentReport } from "@/components/InstrumentReport";
import { WorkflowSteps } from "@/components/WorkflowSteps";
import { HOME_STRUCTURED_DATA, RELEASE_VERSION } from "@/lib/site";

const cliCommand = `npm install --global @preflight-scout/cli@${RELEASE_VERSION} --registry=https://registry.npmjs.org/\npreflight-scout install-browser`;
const codexSkillCommand = "codex plugin marketplace add fenutech/preflight-scout --ref plugin-stable\ncodex plugin add preflight-scout@preflight-scout";
const claudeSkillCommand = "claude plugin marketplace add fenutech/preflight-scout@plugin-stable\nclaude plugin install preflight-scout@preflight-scout";

export default function HomePage() {
  return (
    <>
      <section className="hero-section">
        <div className="hero-copy">
          <p className="eyebrow">RELEASE VERIFICATION FOR CODING AGENTS</p>
          <h1>Turn “done” into verifiable evidence.</h1>
          <p className="hero-lede">Scout turns a diff into focused checks, runs them within explicit execution boundaries, and gives your agents, CI, and reviewers the evidence for release.</p>
          <p className="agent-entry">For AI agents: <a href="/llms.txt">preflightscout.com/llms.txt</a></p>
          <AgentSetup />
          <div className="trust-line" aria-label="Open source, runs in your repository, explicit execution boundaries">
            <span>Open source</span><CircleIcon size={7} weight="fill" aria-hidden="true" /><span>Runs in your repository</span><CircleIcon size={7} weight="fill" aria-hidden="true" /><span>Explicit execution boundaries</span>
          </div>
          <p className="release-availability-note">Before running the commands, confirm <a href={`https://github.com/fenutech/preflight-scout/releases/tag/v${RELEASE_VERSION}`}>GitHub release v{RELEASE_VERSION}</a> and <a href={`https://www.npmjs.com/package/@preflight-scout/cli/v/${RELEASE_VERSION}`}>the matching npm package</a> both exist. If either is missing, use the source path on the <a href="/install/">install page</a>.</p>
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
