import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { query, type ResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createDefaultVerifier, runIntentGate } from "./intent-gate.js";

// --- Types ---

import type { InputEntry } from "./types.js";

interface SkillFrontmatter {
  provider?: string;
  model?: string;
  tools?: string[];
  "permission-mode"?: string;
  [key: string]: unknown;
}

// --- Helpers ---

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

// --- Provider ---

type Provider = (prompt: string, options: {
  cwd: string;
  sidekickUrl: string;
  model?: string;
  tools?: string[];
  permissionMode?: string;
}) => Promise<string>;

const claudeProvider: Provider = async (prompt, options) => {
  let resultText = "";

  for await (const message of query({
    prompt,
    options: {
      cwd: options.cwd,
      model: options.model,
      allowedTools: options.tools,
      mcpServers: {
        sidekick: { url: options.sidekickUrl },
      },
      permissionMode: (options.permissionMode ?? "auto") as "auto",
      allowDangerouslySkipPermissions: true,
      maxTurns: 50,
    },
  })) {
    if ("result" in message) {
      resultText = (message as ResultMessage).result;
    }
  }

  return resultText;
};

const providers: Record<string, Provider> = {
  claude: claudeProvider,
};

// --- Main ---

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

  const raw = readFileSync(skillPath, "utf-8");
  const { data, content } = matter(raw);
  const frontmatter = data as SkillFrontmatter;
  const body = content.trim();

  let inputs: Record<string, InputEntry>;
  try {
    inputs = JSON.parse(inputsJson);
  } catch (e) {
    console.error(`Error: Failed to parse inputs: ${(e as Error).message}`);
    process.exit(1);
  }

  // Intent Gate: verify evidenced inputs
  const verifier = createDefaultVerifier();
  const gate = await runIntentGate(inputs, verifier);
  if (gate.isErr()) {
    console.error(`[skill-action] Intent Gate failed: ${gate.error}`);
    process.exit(1);
  }

  const providerName = frontmatter.provider ?? "claude";
  const provider = providers[providerName];
  if (!provider) {
    console.error(`Error: Unknown provider: ${providerName}`);
    process.exit(1);
  }

  const prompt = buildPrompt(body, inputs);
  console.log(`[skill-action] Running skill: ${skill} (provider: ${providerName}${frontmatter.model ? `, model: ${frontmatter.model}` : ""})`);

  const resultText = await provider(prompt, {
    cwd,
    sidekickUrl,
    model: frontmatter.model,
    tools: frontmatter.tools,
    permissionMode: frontmatter["permission-mode"],
  });

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
  console.error(`[skill-action] Fatal: ${(e as Error).message}`);
  process.exit(1);
});
