// @preflight-scout-requires-browser
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyStoredAuthentication } from "./auth-verification.js";

describe("verifyStoredAuthentication", () => {
  let server: Server;
  let baseUrl: string;
  let dir: string;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><body>
        <form data-testid="login-form"><input type="password"></form>
        <div data-testid="user-menu" hidden>Signed in</div>
        <script>
          if (localStorage.getItem("verified-user")) {
            document.querySelector('[data-testid="login-form"]').hidden = true;
            document.querySelector('[data-testid="user-menu"]').hidden = false;
          }
        </script>
      </body>`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Could not start auth verification server");
    baseUrl = `http://127.0.0.1:${address.port}`;
    dir = await mkdtemp(path.join(tmpdir(), "preflight-scout-auth-verification-"));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  });

  it("accepts saved state only when the exact reviewed signed-in marker is visible", async () => {
    const storageState = path.join(dir, "valid.json");
    await writeFile(storageState, JSON.stringify({
      cookies: [],
      origins: [{ origin: baseUrl, localStorage: [{ name: "verified-user", value: "qa" }] }]
    }));

    await expect(verifyStoredAuthentication({
      baseUrl,
      startPath: "/login",
      signedInTarget: "testid=user-menu",
      storageState
    })).resolves.toBeUndefined();
  });

  it("fails closed when structurally valid state does not reveal the reviewed marker", async () => {
    const storageState = path.join(dir, "unverified.json");
    await writeFile(storageState, JSON.stringify({ cookies: [], origins: [] }));

    await expect(verifyStoredAuthentication({
      baseUrl,
      startPath: "/login",
      signedInTarget: "testid=user-menu",
      storageState
    })).resolves.toContain("not visible");
  });
});
