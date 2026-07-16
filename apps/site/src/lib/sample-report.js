import reportSummary from "../../../../examples/sample-report/report-summary.json";
import mission from "../../../../examples/sample-report/mission.json";
import expiredObservation from "../../../../examples/sample-report/auto-expired-promo/final-observation.json";
import validObservation from "../../../../examples/sample-report/auto-valid-promo/final-observation.json";

export const sampleReport = reportSummary;

const missionById = Object.fromEntries(mission.automationCandidates.map((candidate) => [candidate.id, candidate]));
const observationByMission = {
  "auto-valid-promo": validObservation,
  "auto-expired-promo": expiredObservation
};

export const sampleMissionDetails = {
  runLabel: "PS-01  LOCAL RUN",
  repository: "fixture/checkout",
  branch: "feat/promo-total",
  timestamp: `${reportSummary.generatedAt.slice(11, 19)}Z`,
  browser: "Chromium",
  missionById,
  observationByMission,
  evidenceByMission: Object.fromEntries(reportSummary.browserMissions.map((result) => [result.id, result.evidence?.finalObservationPath])),
  comparisonByMission: {
    "auto-expired-promo": { expected: "$100.00", observed: "$90.00" }
  }
};
