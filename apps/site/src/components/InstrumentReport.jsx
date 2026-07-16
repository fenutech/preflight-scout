import { CheckCircleIcon, XCircleIcon } from "@phosphor-icons/react/ssr";
import { sampleMissionDetails, sampleReport } from "@/lib/sample-report";

const statusIcon = {
  passed: CheckCircleIcon,
  failed: XCircleIcon,
  blocked: XCircleIcon
};

function MissionResult({ mission }) {
  const Icon = statusIcon[mission.status] ?? XCircleIcon;
  const status = mission.status.toUpperCase();
  const comparison = sampleMissionDetails.comparisonByMission[mission.id];
  const candidate = sampleMissionDetails.missionById[mission.id];
  const observation = sampleMissionDetails.observationByMission[mission.id];
  const viewport = observation?.viewport ? `${observation.viewport.width}×${observation.viewport.height}` : "Unknown";
  return (
    <article className={`mission-result ${mission.status}`}>
      <Icon className="mission-status-icon" size={40} weight="regular" aria-hidden="true" />
      <div className="mission-result-body">
        <div className="mission-title-row">
          <h3>{mission.title ?? mission.id}</h3>
          <strong>{status}</strong>
        </div>
        <dl className="mission-detail-list">
          <div><dt>URL:</dt><dd>{candidate?.startPath ?? "/"}</dd></div>
          <div><dt>Viewport:</dt><dd>{viewport} <span aria-hidden="true">·</span> Browser: {sampleMissionDetails.browser}</dd></div>
          {comparison ? <div className="mission-comparison"><dt>Expected:</dt><dd>{comparison.expected} <span aria-hidden="true">·</span> <span>Observed: {comparison.observed}</span></dd></div> : null}
          <div><dt>Evidence:</dt><dd>{sampleMissionDetails.evidenceByMission[mission.id]}</dd></div>
        </dl>
      </div>
    </article>
  );
}

export function InstrumentReport({ compact = false }) {
  return (
    <section className={`instrument-report${compact ? " compact" : ""}`} aria-label="Illustrative Preflight Scout report">
      <div className="instrument-content">
        <div className="instrument-meta" aria-label="Run metadata">
          <span>{sampleMissionDetails.runLabel}</span>
          <span>REPO: {sampleMissionDetails.repository}</span>
          <span>BRANCH: {sampleMissionDetails.branch}</span>
          <span>{sampleMissionDetails.timestamp}</span>
        </div>
        <div className="report-heading">
          <p>PRE-FLIGHT REPORT</p>
          <div className="report-risk"><span>Risk</span><strong>{sampleReport.risk.toUpperCase()}</strong></div>
          <h2>{sampleReport.releaseDecision.status === "do_not_ship_yet" ? "DO NOT SHIP YET" : "READY FOR HUMAN REVIEW"}</h2>
        </div>
        <div className="mission-results">
          {sampleReport.browserMissions.map((mission) => <MissionResult key={mission.id} mission={mission} />)}
        </div>
        <div className="report-totals" aria-label="Report totals">
          <span>Checks run: <strong>{sampleReport.counts.browserMissions}</strong></span>
          <span className="passed">Passed: <strong>{sampleReport.counts.passed}</strong></span>
          <span className="failed">Failed: <strong>{sampleReport.counts.failed}</strong></span>
          <span>Blocked: <strong>{sampleReport.counts.blocked}</strong></span>
        </div>
        <p className="instrument-foot">LOCAL EVIDENCE <span aria-hidden="true">·</span> HUMAN REVIEW REQUIRED</p>
      </div>
    </section>
  );
}
