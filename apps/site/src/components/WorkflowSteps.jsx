import { ArrowRightIcon, CrosshairSimpleIcon, FileCodeIcon, FileTextIcon } from "@phosphor-icons/react/ssr";

const steps = [
  {
    title: "Read the diff",
    body: "It lists the routes, roles, APIs, and product flows the change may touch.",
    icon: FileCodeIcon
  },
  {
    title: "Run the checks that matter",
    body: "It turns that list into a small browser plan and runs only the steps you approve.",
    icon: CrosshairSimpleIcon
  },
  {
    title: "Review the evidence",
    body: "It saves screenshots, traces, console errors, and the final result. You decide whether to ship.",
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
