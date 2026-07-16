import { CheckIcon, CopySimpleIcon } from "@phosphor-icons/react/ssr";

export function CopyCommand({ command, label = "Copy command" }) {
  return (
    <button className="copy-command" type="button" data-copy-command={command} data-copied="false" aria-label={label}>
      <CopySimpleIcon className="copy-icon" size={20} aria-hidden="true" />
      <CheckIcon className="copy-success-icon" size={20} weight="bold" aria-hidden="true" />
      <span className="sr-only" data-copy-feedback aria-live="polite">{label}</span>
    </button>
  );
}

export function CommandLine({ children, copyText, multiline = false }) {
  return (
    <div className={`command-line${multiline ? " multiline" : ""}`}>
      <code>{children}</code>
      <CopyCommand command={copyText ?? String(children)} />
    </div>
  );
}
