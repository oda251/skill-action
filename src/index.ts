import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { query, type ResultMessage } from "@anthropic-ai/claude-agent-sdk";

interface PlainInput {
  type: "plain";
  value: string;
}

interface Citation {
  type: "transcript" | "uri" | "command";
  source?: string;
  command?: string;
  excerpt: string;
}

interface EvidencedInput {
  type: "evidenced";
  body: string;
  citations: Citation[];
}

type InputEntry = PlainInput | EvidencedInput | string;

function getInput(name: string, required = false): string {
  const val = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] ?? "";
  if (required && !val) {
    console.error(`Error: '${name}' input is required`);
    process.exit(1);
  }
  return val;
}

function formatInputs(inputs: Record<string, InputEntry>): string {
  return Object.entries(inputs)
    .map(([key, entry]) => {
      if (typeof entry === "string") return `- **${key}**: ${entry}`;
      if (entry.type === "plain") return `- **${key}**: ${entry.value}`;
      const lines = [`- **${key}**: ${entry.body}`];
      for (const c of entry.citations) {
        const source = c.type === "transcript" ? "(transcript)" : c.source ?? c.command ?? "";
        lines.push(`  - source: \`${source}\` — "${c.excerpt}"`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildPrompt(body: string, inputs: Record<string, InputEntry>): string {
  return [
    `## Task\n\n### Inputs\n\n${formatInputs(inputs)}`,
    `## Workflow\n\n${body}`,
    `## Protocol\n\nIf inputs are insufficient, reject immediately.\nWhen done, report completion.`,
  ].join("\n\n");
}

async function main() {
  const skill = getInput("skill", true);
  const inputsJson = getInput("inputs", true);
  const sidekickUrl = getInput("sidekick-url") || "http://127.0.0.1:4312/mcp";
  const cwd = getInput("cwd") || process.env.GITHUB_WORKSPACE || process.cwd();

  const skillPath = join(cwd, ".claude", "skills", `${skill}.md`);
  if (!existsSync(skillPath)) {
    console.error(`Error: Skill file not found: ${skillPath}`);
    process.exit(1);
  }

  const content = readFileSync(skillPath, "utf-8");
  const parts = content.split("---").filter(Boolean);
  const body = parts.length > 1 ? parts.slice(1).join("---").trim() : content;

  let inputs: Record<string, InputEntry>;
  try {
    inputs = JSON.parse(inputsJson);
  } catch (e) {
    console.error(`Error: Failed to parse inputs: ${(e as Error).message}`);
    process.exit(1);
  }

  const prompt = buildPrompt(body, inputs);
  console.log(`[skill-action] Running skill: ${skill}`);

  let resultText = "";

  for await (const message of query({
    prompt,
    options: {
      cwd,
      mcpServers: {
        sidekick: { url: sidekickUrl },
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
    },
  })) {
    if ("result" in message) {
      resultText = (message as ResultMessage).result;
    }
  }

  console.log(`[skill-action] Skill completed: ${skill}`);

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const escaped = resultText
      .replace(/%/g, "%25")
      .replace(/\n/g, "%0A")
      .replace(/\r/g, "%0D");
    appendFileSync(outputFile, `result=${escaped}\n`);
  }
}

main().catch((e) => {
  console.error(`[skill-action] Fatal: ${e.message}`);
  process.exit(1);
});
