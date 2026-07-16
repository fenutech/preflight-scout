import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createTrustedGit, type TrustedGit } from "@preflight-scout/core";

const DEMO_MARKER = `${JSON.stringify({ kind: "preflight-scout-generic-demo", version: 1 })}\n`;
const DEMO_MARKER_PATH = path.join(".preflight-scout", "demo-marker.json");

export interface DemoRepoResult {
  root: string;
  base: string;
  head: string;
  appUrl: string;
}

export type DemoScenario = "checkout" | "auth-dashboard";

export async function createGenericDemoRepo(options: { output: string; force?: boolean; scenario?: DemoScenario }): Promise<DemoRepoResult> {
  const requestedRoot = path.resolve(options.output);
  const scenario = options.scenario ?? "checkout";
  const root = await prepareDemoOutput(requestedRoot, options.force ?? false);
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, ".preflight-scout"), { recursive: true });
  await writeFile(path.join(root, DEMO_MARKER_PATH), DEMO_MARKER, { encoding: "utf8", mode: 0o600, flag: "wx" });

  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: `preflight-scout-generic-${scenario}-demo`,
    private: true,
    type: "module",
    scripts: {
      start: "python3 -m http.server 4173"
    }
  }, null, 2));
  await writeFile(path.join(root, ".gitignore"), ".preflight-scout/auth/\n.preflight-scout/runs/\n.preflight-scout/approvals.local.yml\n.env.preflight-scout.local\n!.env.preflight-scout.example\n");
  await writeFile(path.join(root, ".preflight-scout", "config.yml"), scenario === "checkout" ? checkoutContract() : authDashboardContract());
  await writeFile(path.join(root, "index.html"), scenario === "checkout" ? baseHtml() : baseAuthHtml());
  await writeFile(path.join(root, "src", scenario === "checkout" ? "checkout.js" : "auth-dashboard.js"), scenario === "checkout" ? baseCheckoutJs() : baseAuthDashboardJs());

  const trustedGit = await createTrustedGit({ targetRoot: root });
  await git(trustedGit, root, "init", "-b", "main");
  await git(trustedGit, root, "config", "user.email", "preflight-scout-demo@example.com");
  await git(trustedGit, root, "config", "user.name", "Preflight Scout Demo");
  await git(trustedGit, root, "add", ".");
  await git(trustedGit, root, "commit", "-m", `Initial generic ${scenario} demo`);

  await writeFile(path.join(root, "index.html"), scenario === "checkout" ? changedHtml() : changedAuthHtml());
  await writeFile(path.join(root, "src", scenario === "checkout" ? "checkout.js" : "auth-dashboard.js"), scenario === "checkout" ? changedCheckoutJs() : changedAuthDashboardJs());
  await git(trustedGit, root, "add", ".");
  await git(trustedGit, root, "commit", "-m", scenario === "checkout" ? "Add promo validation feedback" : "Add admin analytics panel");

  return {
    root,
    base: "HEAD~1",
    head: "HEAD",
    appUrl: "http://127.0.0.1:4173"
  };
}

async function prepareDemoOutput(requestedRoot: string, force: boolean): Promise<string> {
  const root = await canonicalDemoOutputPath(requestedRoot);
  await assertSafeDemoRoot(root);
  let stats;
  try {
    stats = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return root;
    throw error;
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing demo output path that is not a regular directory: ${root}`);
  }
  if (!force) {
    throw new Error(`Demo output already exists: ${root}. Choose a new child path or pass --force for an existing Preflight Scout demo.`);
  }
  await assertExistingDemoMarker(root);
  await rm(root, { recursive: true, force: false, maxRetries: 2, retryDelay: 50 });
  return root;
}

async function assertSafeDemoRoot(root: string): Promise<void> {
  if (!path.isAbsolute(root)) throw new Error("Demo output must be an absolute child path");
  const dangerous = [
    path.parse(root).root,
    await canonicalDemoOutputPath(homedir()),
    await canonicalDemoOutputPath(process.cwd())
  ];
  if (dangerous.some((candidate) => isPathWithin(root, candidate))) {
    throw new Error(`Refusing destructive demo output path: ${root}. Choose a dedicated child directory.`);
  }
}

async function assertExistingDemoMarker(root: string): Promise<void> {
  const marker = path.join(root, DEMO_MARKER_PATH);
  try {
    const stats = await lstat(marker);
    if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 1024) throw new Error("unsafe marker");
    if (await readFile(marker, "utf8") !== DEMO_MARKER) throw new Error("marker mismatch");
  } catch (error) {
    throw new Error(`Refusing --force because ${root} is not a recognizable Preflight Scout demo directory.`, { cause: error });
  }
}

async function canonicalDemoOutputPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  const candidateAnchors = [
    tmpdir(),
    homedir(),
    process.cwd(),
    ...(process.platform === "win32" ? [] : ["/tmp", "/var"]),
    path.parse(resolved).root
  ]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => isPathWithin(candidate, resolved))
    .sort((left, right) => right.length - left.length);
  const lexicalAnchor = candidateAnchors[0] ?? path.parse(resolved).root;
  let cursor = await realpath(lexicalAnchor);
  const segments = path.relative(lexicalAnchor, resolved).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    const candidate = path.join(cursor, segments[index]!);
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        throw new Error(`Refusing demo output path that traverses symbolic link ${candidate}`);
      }
      if (index < segments.length - 1 && !stats.isDirectory()) {
        throw new Error(`Refusing demo output path with non-directory ancestor ${candidate}`);
      }
      cursor = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return path.join(cursor, ...segments.slice(index));
    }
  }
  return cursor;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const left = process.platform === "win32" ? parent.toLowerCase() : parent;
  const right = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function git(trustedGit: TrustedGit, cwd: string, ...args: string[]): Promise<void> {
  await trustedGit.exec(args, { cwd });
}

function checkoutContract(): string {
  return `app:
  name: Generic Shop Demo
  type: static checkout
  localUrl: http://127.0.0.1:4173
  previewUrlSource: manual
defaults:
  baseRef: HEAD~1
  targetEnv: local
  outputDir: .preflight-scout/runs/latest
  headless: true
  trace: true
criticalFlows:
  - checkout
  - promo code
sensitiveAreas:
  - payments
  - pricing
dangerousActions:
  allowed:
    - navigate
    - fill
    - click
  requireApproval:
    - submit_payment
  forbidden:
    - real_payment
testData:
  valid_coupon: SAVE10
  expired_coupon: EXPIRED10
unknowns: []
`;
}

function authDashboardContract(): string {
  return `app:
  name: Generic Auth Dashboard Demo
  type: static authenticated dashboard
  localUrl: http://127.0.0.1:4173
  previewUrlSource: manual
auth:
  loginUrl: /login
  roles:
    qa_user:
      usernameEnv: PREFLIGHT_SCOUT_BROWSER_DEMO_EMAIL
      passwordEnv: PREFLIGHT_SCOUT_BROWSER_DEMO_PASSWORD
      storageState: .preflight-scout/auth/qa_user.json
      signedInTarget: testid=welcome
defaults:
  baseRef: HEAD~1
  targetEnv: local
  outputDir: .preflight-scout/runs/latest
  headless: true
  trace: true
  missionLimit: 2
criticalFlows:
  - login
  - dashboard
  - admin analytics
sensitiveAreas:
  - auth
  - permissions
dangerousActions:
  allowed:
    - navigate
    - login
    - fill
    - click
  requireApproval: []
  forbidden:
    - delete_account
testData:
  demo_email: qa@example.com
  demo_password: password123
unknowns: []
`;
}

function baseHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generic Shop Checkout</title>
  </head>
  <body>
    <main>
      <h1>Checkout</h1>
      <p>Demo cart: Preflight Scout Hoodie, $100.00</p>
      <label>
        Promo code
        <input aria-label="Promo code" data-testid="promo-code" />
      </label>
      <button data-testid="apply-promo">Apply promo</button>
      <p data-testid="order-total">Total: $100.00</p>
    </main>
    <script type="module" src="./src/checkout.js"></script>
  </body>
</html>
`;
}

function changedHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generic Shop Checkout</title>
  </head>
  <body>
    <main>
      <h1>Checkout</h1>
      <p>Demo cart: Preflight Scout Hoodie, $100.00</p>
      <label>
        Promo code
        <input aria-label="Promo code" data-testid="promo-code" />
      </label>
      <button data-testid="apply-promo">Apply promo</button>
      <p data-testid="promo-error" role="alert" hidden>Promo code is expired.</p>
      <p data-testid="order-total">Total: $100.00</p>
    </main>
    <script type="module" src="./src/checkout.js"></script>
  </body>
</html>
`;
}

function baseCheckoutJs(): string {
  return `const input = document.querySelector('[data-testid="promo-code"]');
const total = document.querySelector('[data-testid="order-total"]');

document.querySelector('[data-testid="apply-promo"]').addEventListener("click", () => {
  if (input.value === "SAVE10") {
    total.textContent = "Total: $90.00";
  }
});
`;
}

function changedCheckoutJs(): string {
  return `const input = document.querySelector('[data-testid="promo-code"]');
const total = document.querySelector('[data-testid="order-total"]');
const error = document.querySelector('[data-testid="promo-error"]');

document.querySelector('[data-testid="apply-promo"]').addEventListener("click", () => {
  error.hidden = true;
  if (input.value === "SAVE10") {
    total.textContent = "Total: $90.00";
  } else if (input.value === "EXPIRED10") {
    error.hidden = false;
    total.textContent = "Total: $100.00";
  }
});
`;
}

function baseAuthHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generic Auth Dashboard</title>
  </head>
  <body>
    <main>
      <form data-view="login">
        <h1>Sign in</h1>
        <label>Email <input aria-label="Email" data-testid="email" /></label>
        <label>Password <input aria-label="Password" data-testid="password" type="password" /></label>
        <button type="submit" data-testid="sign-in">Sign in</button>
      </form>
      <section data-view="dashboard" hidden>
        <h1>Dashboard</h1>
        <p data-testid="welcome"></p>
      </section>
    </main>
    <script type="module" src="./src/auth-dashboard.js"></script>
  </body>
</html>
`;
}

function changedAuthHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Generic Auth Dashboard</title>
  </head>
  <body>
    <main>
      <form data-view="login">
        <h1>Sign in</h1>
        <label>Email <input aria-label="Email" data-testid="email" /></label>
        <label>Password <input aria-label="Password" data-testid="password" type="password" /></label>
        <button type="submit" data-testid="sign-in">Sign in</button>
      </form>
      <section data-view="dashboard" hidden>
        <h1>Dashboard</h1>
        <p data-testid="welcome"></p>
        <section data-testid="admin-analytics" hidden>
          <h2>Admin analytics</h2>
          <p>Conversion rate: 12%</p>
        </section>
      </section>
    </main>
    <script type="module" src="./src/auth-dashboard.js"></script>
  </body>
</html>
`;
}

function baseAuthDashboardJs(): string {
  return `const email = document.querySelector('[data-testid="email"]');
const password = document.querySelector('[data-testid="password"]');
const login = document.querySelector('[data-view="login"]');
const dashboard = document.querySelector('[data-view="dashboard"]');
const welcome = document.querySelector('[data-testid="welcome"]');

const existingUser = localStorage.getItem("demo-user");
if (existingUser) {
  login.hidden = true;
  dashboard.hidden = false;
  welcome.textContent = "Signed in as " + existingUser;
}

document.querySelector('[data-testid="sign-in"]').addEventListener("click", (event) => {
  event.preventDefault();
  if (email.value && password.value) {
    localStorage.setItem("demo-user", email.value);
    login.hidden = true;
    dashboard.hidden = false;
    welcome.textContent = "Signed in as " + email.value;
  }
});
`;
}

function changedAuthDashboardJs(): string {
  return `const email = document.querySelector('[data-testid="email"]');
const password = document.querySelector('[data-testid="password"]');
const login = document.querySelector('[data-view="login"]');
const dashboard = document.querySelector('[data-view="dashboard"]');
const welcome = document.querySelector('[data-testid="welcome"]');
const analytics = document.querySelector('[data-testid="admin-analytics"]');

const existingUser = localStorage.getItem("demo-user");
if (existingUser) {
  login.hidden = true;
  dashboard.hidden = false;
  analytics.hidden = false;
  welcome.textContent = "Signed in as " + existingUser;
}

document.querySelector('[data-testid="sign-in"]').addEventListener("click", (event) => {
  event.preventDefault();
  if (email.value && password.value) {
    localStorage.setItem("demo-user", email.value);
    login.hidden = true;
    dashboard.hidden = false;
    analytics.hidden = false;
    welcome.textContent = "Signed in as " + email.value;
  }
});
`;
}
