// index.js
import "dotenv/config";
import minimist from "minimist";
import { runPlanAgent, runWriteAgent } from "./src/agent.js";
import { savePlan, applyWriteSpec } from "./src/writer.js";

async function main() {
  const args = minimist(process.argv.slice(2));
  const prompt = args.prompt || args.p;

  const approved = Boolean(args.approve); // only writes if true
  const force = Boolean(args.force);      // allows overwrite if true

  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY in environment.");
    process.exit(1);
  }

  if (!prompt) {
    console.log('Usage: node index.js --prompt "Your request here" [--approve] [--force]');
    process.exit(0);
  }

  console.log("API Key loaded");
  console.log("\n--- PLAN MODE ---\n");

  const plan = await runPlanAgent({ prompt });
  console.log(plan);

  const savedTo = await savePlan(plan);
  console.log(`\nPlan saved to: ${savedTo}`);

  // Approval gate: stop here unless --approve is provided
  if (!approved) {
    console.log("\nApproval required to write files.");
    console.log('Re-run with: node index.js --prompt "..." --approve');
    return;
  }

  console.log("\n--- APPROVED: WRITE MODE ---\n");
  const writeSpecJson = await runWriteAgent({ prompt, plan });

  const written = await applyWriteSpec(writeSpecJson, { overwrite: force });

  console.log("\nFiles written:");
  for (const f of written) console.log(`- ${f}`);
}

main().catch((err) => {
  console.error(err?.message || err);
  process.exit(1);
});
