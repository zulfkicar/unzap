import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { migrateWithAgent } from "../src/agent.js";
import { importDefinitions } from "../src/migration.js";
const results = [];
const source = JSON.parse(
  readFileSync(
    new URL("../fixtures/find-or-create-paths.json", import.meta.url),
  ),
);
const headers = {
  Authorization: "[redacted]",
  "Content-Type": "application/json",
};
const search = {
  url: "https://api.airtable.com/v0/app_example/Contacts?filterByFormula=%7BEmail%7D%3D%22member%40example.test%22&maxRecords=1&returnFieldsByFieldId=true",
  method: "GET",
  headers: { Authorization: "[redacted]" },
};
const cases = [
  {
    name: "Description to typed mapping",
    description:
      "Build exactly 3 steps. ID 1: JSON webhook. ID 2 after 1: formatter string.trim_space of {{1__email}}. ID 3 after 2: transform fields with email from {{2__output}} and amount from {{1__amount}}. No external calls. Preserve the numeric amount type.",
    fixtures: [
      {
        name: "Whitespace and number",
        input: { email: " member@example.test ", amount: 25 },
        expected_status: "succeeded",
        expected_requests: [],
        expected_outputs: {
          2: { output: "member@example.test" },
          3: { email: "member@example.test", amount: 25 },
        },
      },
      {
        name: "Unicode and zero",
        input: { email: " مقامی ", amount: 0 },
        expected_status: "succeeded",
        expected_requests: [],
        expected_outputs: {
          2: { output: "مقامی" },
          3: { email: "مقامی", amount: 0 },
        },
      },
    ],
  },
  {
    name: "Export to find-or-create code",
    definition: importDefinitions(source)[0],
    description:
      "Preserve every source node and mapping. The imported adapter proposals already preserve these API contracts. Review and clear their review_required flags if appropriate. Use rules in Path 5 and fallback Path 7. Keep both branches. Do not change the Email search field or exact matching.",
    fixtures: [
      {
        name: "Miss creates",
        input: { email: " member@example.test ", name: "Example Member" },
        expected_status: "succeeded",
        expected_requests: [
          search,
          {
            url: "https://api.airtable.com/v0/app_example/Contacts",
            method: "POST",
            headers,
            body: '{"records":[{"fields":{"Email":"member@example.test","Name":"Example Member"}}]}',
          },
        ],
      },
      {
        name: "Match updates",
        input: { email: " member@example.test ", name: "Example Member" },
        responses: {
          3: { records: [{ id: "rec_demo_found", fields: { Name: "Old" } }] },
        },
        expected_status: "succeeded",
        expected_requests: [
          search,
          {
            url: "https://api.airtable.com/v0/app_example/Contacts/rec_demo_found",
            method: "PATCH",
            headers,
            body: '{"fields":{"Name":"Example Member"}}',
          },
        ],
      },
    ],
  },
];
for (const c of cases) {
  if (process.env.AGENT_CASE && c.name !== process.env.AGENT_CASE) continue;
  console.log("Starting " + c.name);
  const result = await migrateWithAgent({
    ...c,
    onProgress: (e) =>
      console.log(
        JSON.stringify({
          tool: e.tool,
          status: e.status,
          detail: e.detail?.slice(0, 120),
        }),
      ),
  });
  results.push({ name: c.name, result });
  console.log(
    JSON.stringify({
      case: c.name,
      status: result.status,
      fixture_passed: result.tests?.passed,
    }),
  );
  mkdirSync(".data", { recursive: true });
  writeFileSync(
    ".data/local-agent-verification.json",
    JSON.stringify(
      {
        model: process.env.OLLAMA_MODEL || "qwen3:4b",
        provenance:
          "Actual local Ollama inference. Authored inputs and export-shaped fixture, not live SaaS.",
        results,
      },
      null,
      2,
    ),
  );
}
if (
  results.some(
    (c) => c.result.status !== "draft_complete" || !c.result.tests?.passed,
  )
)
  process.exitCode = 1;
