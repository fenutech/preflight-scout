import { BrowserIcon, CheckCircleIcon, RobotIcon, TerminalWindowIcon } from "@phosphor-icons/react/ssr";
import { CommandLine } from "@/components/CopyCommand";
import { pageMetadata, RELEASE_VERSION } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Install the CLI and Agent Skill",
  description: "Install the Preflight Scout CLI, Chromium browser, and agent skill for Codex or Claude Code with version-pinned commands.",
  path: "/install/"
});

const commands = {
  verify: `npm view @preflight-scout/cli@${RELEASE_VERSION} version --registry=https://registry.npmjs.org/`,
  cli: `npm install --global @preflight-scout/cli@${RELEASE_VERSION} --registry=https://registry.npmjs.org/`,
  browser: "preflight-scout install-browser",
  codex: "codex plugin marketplace add fenutech/preflight-scout\ncodex plugin add preflight-scout@preflight-scout",
  claude: "claude plugin marketplace add fenutech/preflight-scout\nclaude plugin install preflight-scout@preflight-scout",
  firstRunCodex: "export PREFLIGHT_SCOUT_LLM_PROVIDER=codex-exec\npreflight-scout init --no-llm --base origin/main\npreflight-scout doctor --base origin/main --head HEAD --agent codex\npreflight-scout analyze --base origin/main --head HEAD --open-report",
  firstRunClaude: "export PREFLIGHT_SCOUT_LLM_PROVIDER=claude-exec\npreflight-scout init --no-llm --base origin/main\npreflight-scout doctor --base origin/main --head HEAD --agent claude\npreflight-scout analyze --base origin/main --head HEAD --open-report"
};

const phases = [
  {
    number: "01",
    title: "Install the CLI",
    body: "The CLI reads the diff, runs the approved browser mission, and writes the evidence packet. Node.js 22.13 or newer is required.",
    icon: TerminalWindowIcon,
    command: commands.cli
  },
  {
    number: "02",
    title: "Install Chromium",
    body: "Chromium is installed separately so the npm package stays small.",
    icon: BrowserIcon,
    command: commands.browser
  }
];

export default function InstallPage() {
  return (
    <div className="subpage">
      <header className="subpage-intro">
        <p className="eyebrow">INSTALLATION / TWO PARTS</p>
        <h1>Install Preflight Scout for Codex or Claude Code.</h1>
        <p>The skill tells Codex or Claude Code how to use Preflight Scout. The CLI reads the diff, runs Chromium, and saves the report.</p>
      </header>

      <section className="release-check" aria-labelledby="registry-check-title">
        <CheckCircleIcon size={36} weight="thin" aria-hidden="true" />
        <div>
          <h2 id="registry-check-title">Confirm the alpha exists before installing</h2>
          <p>The package is intentionally version-pinned. If npm does not return <code>{RELEASE_VERSION}</code>, use the source path documented in the repository instead.</p>
          <CommandLine copyText={commands.verify}>{commands.verify}</CommandLine>
        </div>
      </section>

      <div className="install-grid">
        {phases.map((phase) => {
          const Icon = phase.icon;
          return (
            <section className="install-card" key={phase.number}>
              <div className="install-card-top"><span>{phase.number}</span><Icon size={42} weight="thin" aria-hidden="true" /></div>
              <h2>{phase.title}</h2>
              <p>{phase.body}</p>
              <CommandLine copyText={phase.command}>{phase.command}</CommandLine>
            </section>
          );
        })}
      </div>

      <section className="agent-install" aria-labelledby="agent-install-title">
        <div className="agent-install-heading">
          <RobotIcon size={52} weight="thin" aria-hidden="true" />
          <div><p className="section-index">03 / AGENT SKILL</p><h2 id="agent-install-title">Add Preflight Scout to your coding agent</h2></div>
        </div>
        <div className="agent-command-grid">
          <div><h3>Codex</h3><CommandLine copyText={commands.codex} multiline>{commands.codex}</CommandLine><p>Invoke <code>$preflight-scout:preflight-scout</code>.</p></div>
          <div><h3>Claude Code</h3><CommandLine copyText={commands.claude} multiline>{commands.claude}</CommandLine><p>Invoke <code>/preflight-scout:preflight-scout</code>.</p></div>
        </div>
        <p className="agent-session-note">After either install, restart the client and start a new task or session in the repository before invoking the skill.</p>
      </section>

      <aside className="next-callout">
        <p className="eyebrow">FIRST RUN</p>
        <h2>Use your signed-in coding agent, check the setup, then generate a plan for the current diff.</h2>
        <div className="agent-command-grid first-run-grid">
          <div><h3>Codex</h3><CommandLine multiline copyText={commands.firstRunCodex}>{commands.firstRunCodex}</CommandLine></div>
          <div><h3>Claude Code</h3><CommandLine multiline copyText={commands.firstRunClaude}>{commands.firstRunClaude}</CommandLine></div>
        </div>
        <p>On PowerShell, replace the first line with <code>$env:PREFLIGHT_SCOUT_LLM_PROVIDER = &quot;codex-exec&quot;</code> or <code>$env:PREFLIGHT_SCOUT_LLM_PROVIDER = &quot;claude-exec&quot;</code>. The remaining commands are the same.</p>
        <p><code>init --no-llm</code> creates the local config and ignore rules without spending a model call. These paths then use your authenticated Codex or Claude Code CLI for the current diff. API-provider alternatives are documented in the repository. Use local, preview, or staging targets with test accounts, and <a href="/security/">read the data and security boundaries</a> before an authenticated run.</p>
      </aside>
    </div>
  );
}
