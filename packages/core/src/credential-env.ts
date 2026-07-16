export type BrowserCredentialKind = "username" | "password";

const DEDICATED_BROWSER_CREDENTIAL_PATTERN = /^PREFLIGHT_SCOUT_BROWSER_[A-Z0-9]+(?:_[A-Z0-9]+)*_(EMAIL|USERNAME|PASSWORD)$/;

/**
 * Browser-fill credentials live in a dedicated namespace so repository-owned
 * role configuration cannot reinterpret provider, infrastructure, or generic
 * process credentials as values that may be typed into a webpage.
 */
export function browserCredentialKindForEnvName(value: string | undefined): BrowserCredentialKind | undefined {
  if (!value) return undefined;
  const match = value.match(DEDICATED_BROWSER_CREDENTIAL_PATTERN);
  if (!match) return undefined;
  return match[1] === "PASSWORD" ? "password" : "username";
}

export function browserCredentialEnvName(
  value: string | undefined,
  kind: BrowserCredentialKind
): string | undefined {
  return browserCredentialKindForEnvName(value) === kind ? value : undefined;
}
