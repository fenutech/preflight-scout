import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { QAMission } from "@preflight-scout/core";

export interface MCPServerCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export async function withMCPClient<T>(
  server: MCPServerCommand,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({
    name: "preflight-scout",
    version: "0.1.2"
  });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...process.env, ...server.env } as Record<string, string>
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function listMCPTools(server: MCPServerCommand) {
  return withMCPClient(server, async (client) => client.listTools());
}

export async function callMCPTool(server: MCPServerCommand, name: string, args: Record<string, unknown>) {
  return withMCPClient(server, async (client) => client.callTool({ name, arguments: args }));
}

export async function executeMissionViaPromptTool(options: {
  server: MCPServerCommand;
  toolName: string;
  mission: QAMission;
  appUrl: string;
  argumentName?: string;
}) {
  const prompt = missionAsAgentPrompt(options.mission, options.appUrl);
  return callMCPTool(options.server, options.toolName, {
    [options.argumentName ?? "prompt"]: prompt
  });
}

export function missionAsAgentPrompt(mission: QAMission, appUrl: string): string {
  return `You are running Preflight Scout browser verification.

Use the available browser MCP tools to execute this QA mission against:
${appUrl}

Rules:
- Follow the mission exactly.
- Do not invent extra destructive steps.
- If a target is ambiguous, inspect the page and report blocked instead of guessing.
- Capture evidence: screenshots, visible state, URL transitions, console/network errors if tools expose them.
- Return JSON with passed, failed, blocked, evidence, and human_followups.

Mission:
${JSON.stringify(mission, null, 2)}
`;
}
