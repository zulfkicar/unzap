# Adapter and local-agent verification — 2026-10-10

46 regression tests pass on Windows Node 24 and WSL Docker. Coverage includes nested sequential Paths, fallback behavior, branch-local filter stops, skipped-step journaling, cross-branch rejection, source topology preservation, typed transforms, date/timezone handling, Airtable search/create/update, HTTP serialization, rich Slack mappings, crash recovery and recorded-response replay.

## Actual export corpus

The supplied private ZIP was parsed locally, without executing source code or making SaaS calls. All 4,083 workflows, 27,691 nodes and 1,279 branching points retain their IDs and parent links.

| Measure | Result | Meaning |
| --- | ---: | --- |
| Recognized adapter nodes | 14,530 | A known action kind is available. Other parameter or trigger blockers may remain. |
| Immediately compiler-ready workflows | 14 | No static blockers or pending mapping reviews. Not a provider parity claim. |
| Compiler-ready after mapping review | 164 | Includes the 14 above and 150 workflows whose remaining blockers are mapping review. |
| Unknown adapter nodes | 13,161 | No executable replacement is silently guessed. |

Remaining blockers include event/polling triggers, Sheets, delays, regex and spreadsheet formulas, custom code, proprietary app contracts, ambiguous branch ordering and invalid or incomplete source configurations. Compile coverage is not execution equivalence. Actual run recordings and live sandbox validation are still required for cutover.

## Actual local-model evaluation

Ollama runs in WSL Docker and inference stays local. The current pilot model is `qwen3:4b`, a pretrained model with **no Unzap fine-tuning**.

- A description generated a webhook, whitespace formatter and typed transform. Two independent cases verified Unicode, numeric zero, output fields and the absence of external requests. The model passed on its first proposal.
- An export-shaped eight-node source exercised Airtable find/update/create, a Paths group, a conditional branch and a fallback. Both found/missing scenarios passed independently authored request checks. The successful model operation reviewed exact adapter mappings while preserving the decoded source graph.
- The 3B coding model failed earlier pilots. Whole-graph regeneration with the 4B model also produced semantic or missing-node errors. These unsuccessful results remain in ignored local verification artifacts. They are not included in the successful-case count.

The agent separates a single trigger from action proposals, uses typed schemas, preserves imported topology, constrains source cardinality and automatically compiles/tests accepted candidates. Known exact mappings are reviewed without asking the model to rewrite a correct graph. The repair loop keeps the requirements, latest definition and tool feedback rather than growing an unbounded transcript.

This is a two-workflow local pilot, not a corpus-wide model benchmark. The independently authored provider fixtures are fictional and source-shaped, not recordings from a live Slack/Airtable account.

The browser walkthrough also completed model review in the running app, inspected both passing branch/request cases, saved a new draft version and passed both cases through the SQLite-backed runtime on that version. The example remains inactive and no live API writes were made.

## Response replay and operations

Fixtures can contain native API response bodies and expected outputs keyed by step ID. They are encrypted in SQLite, bound into mock-run idempotency and retained across restarts. A malformed/null response cannot fall back to generic mock success. Response overrides are rejected in live mode.

Interrupted write adapters become uncertain using the shared action registry. Read-only search can resume safely. A model-reviewed draft creates a version only when saved by the operator. It does not activate the workflow or change credentials.

Run the optional local-model pilot with `node scripts/verify-local-agent.mjs`. `AGENT_CASE` selects one case, and `OLLAMA_MODEL` selects an installed local model. The report contains fictional fixtures and is written to ignored `.data/local-agent-verification.json`.
