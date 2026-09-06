import { compileFromFile } from "json-schema-to-typescript";
import { execSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const schemaDir = "schemas";
const tsOutDir = "generated/ts";
const pyOutDir = "generated/py";
mkdirSync(tsOutDir, { recursive: true });
mkdirSync(pyOutDir, { recursive: true });

const contractsDir = "../ai-service/app/contracts";

for (const file of readdirSync(schemaDir)) {
  if (!file.endsWith(".schema.json")) continue;
  const name = file.replace(".schema.json", "");
  // TS side keeps hyphenated filenames (just a path string, reads naturally next to the schema).
  // Python side MUST use underscores: `signal-decision.py` cannot be imported as a module.
  const pyName = name.replace(/-/g, "_");
  // unreachableDefinitions: SignalDecisionRequest/Response live in `definitions` but are never
  // $ref'd from the root schema (only PhaseCandidate is) — without this flag,
  // json-schema-to-typescript only hoists $ref-reachable definitions to top-level named
  // interfaces, silently dropping the other two into nowhere and leaving nothing for
  // AiSignalClient.ts to import (a real bug found only by running `tsc --noEmit`, since
  // vitest's looser module resolution never surfaced the missing export).
  const ts = await compileFromFile(path.join(schemaDir, file), { unreachableDefinitions: true });
  writeFileSync(path.join(tsOutDir, `${name}.schema.d.ts`), ts);

  if (existsSync("../ai-service")) {
    // --disable-timestamp: without it, datamodel-codegen bakes a wall-clock "generated at" comment
    // into every output file, so two runs against the *same* schema always produce a byte-diff —
    // which made CI's contracts-drift check ("regenerate, then git diff --exit-code") fail on
    // every single run regardless of whether the schemas actually changed.
    execSync(
      `uvx --from datamodel-code-generator datamodel-codegen --input ${path.join(schemaDir, file)} --input-file-type jsonschema --output ${path.join(pyOutDir, `${pyName}_schema.py`)} --disable-timestamp`,
      { stdio: "inherit" }
    );
  }
}

// Copy generated Python types into ai-service so uv doesn't need pnpm workspace resolution.
if (existsSync("../ai-service")) {
  mkdirSync(contractsDir, { recursive: true });
  execSync(`cp -r ${pyOutDir}/* ${contractsDir}/`);
}
