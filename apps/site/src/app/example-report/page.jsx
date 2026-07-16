import { ArrowSquareOutIcon, FileHtmlIcon, FlaskIcon } from "@phosphor-icons/react/ssr";
import { InstrumentReport } from "@/components/InstrumentReport";
import { pageMetadata } from "@/lib/site";

export const metadata = pageMetadata({
  title: "Example Release QA Report",
  description: "Inspect a Preflight Scout release QA report with a passing browser check, a failed check, and the evidence files behind each result.",
  path: "/example-report/"
});

export default function ExampleReportPage() {
  return (
    <div className="subpage report-page">
      <header className="subpage-intro report-intro">
        <p className="eyebrow">SAMPLE REPORT</p>
        <h1>See what passed, what failed, and the files behind each result.</h1>
        <p>This sample uses a fake checkout: one promo-code check passes and one fails. The paths and results are fixed so you can inspect the report without running a live app.</p>
      </header>
      <InstrumentReport />
      <div className="report-actions">
        <a className="button primary" href="/example-report/report.html" target="_blank" rel="noopener noreferrer"><FileHtmlIcon size={26} aria-hidden="true" />Open the full HTML report<span className="sr-only"> in a new tab</span></a>
        <a className="button secondary" href="https://github.com/fenutech/preflight-scout/tree/main/examples/sample-report"><ArrowSquareOutIcon size={26} aria-hidden="true" />Inspect the fixture files</a>
      </div>
      <section className="fixture-note">
        <FlaskIcon size={44} weight="thin" aria-hidden="true" />
        <div><h2>About this sample</h2><p>These files are sample data. A real run saves screenshots, a Playwright trace, console and network errors, final observations, and Markdown, HTML, JSON, and optional PDF reports in your local run directory.</p></div>
      </section>
    </div>
  );
}
