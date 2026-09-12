import { ArrowRightIcon, CrosshairSimpleIcon, FileCodeIcon, FileTextIcon } from "@phosphor-icons/react/ssr";

const steps = [
  {
    title: "Plan for this change",
    body: "Scout ties the analysis to your Git revisions and proposes checks for the affected flows. Your agent can review the plan.",
    icon: FileCodeIcon
  },
  {
    title: "Run within your boundaries",
    body: "Agents execute within standing authorization. The built-in runner enforces reviewed actions, permissions, and the target origin.",
    icon: CrosshairSimpleIcon
  },
  {
    title: "Use the evidence",
    body: "Screenshots, traces, failures, and final observations feed your agent, CI gate, or human review. Your release policy decides what follows.",
    icon: FileTextIcon
  }
];

export function WorkflowSteps() {
  return (
    <section className="workflow-section" id="how-it-works" aria-labelledby="workflow-heading">
      <p className="eyebrow" id="workflow-heading">HOW IT WORKS</p>
      <div className="workflow-grid">
        {steps.map((step, index) => {
          const Icon = step.icon;
          return (
            <div className="workflow-step-wrap" key={step.title}>
              <article className="workflow-step">
                <Icon className="workflow-icon" size={64} weight="thin" aria-hidden="true" />
                <div>
                  <h2>{step.title}</h2>
                  <p>{step.body}</p>
                </div>
              </article>
              {index < steps.length - 1 ? <ArrowRightIcon className="workflow-arrow" size={25} aria-hidden="true" /> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
