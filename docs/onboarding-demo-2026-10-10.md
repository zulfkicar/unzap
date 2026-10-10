# Unzap portfolio onboarding

The public walkthrough is a static application at `/demo/`. It is separate from the authenticated control application. OAuth app registration has moved from Connections into Admin settings. The local installation still has one operator login, not a multi-user role system.

## Visitor path

1. Load an original synthetic service-request Zap or select a local JSON export.
2. Inspect source steps, mapped parameters, references and branch structure. Review-required mappings need explicit approval. Unknown actions remain blockers.
3. Assign a simulated named account across all steps for the same provider.
4. Run generated code using synthetic API responses. Inspect step trace, requests, redacted authentication and outputs.
5. Download the generated JavaScript or reviewed definition. Read the separate engineering view for model, runtime and OAuth contracts.

## Implementation

`scripts/build-demo.mjs` bundles existing source modules with esbuild. The browser-only crypto compatibility layer uses SHA-256 from `@noble/hashes`, and Buffer compatibility comes from `buffer`. The production Node runtime continues using Node crypto. Dependencies are pinned in the npm lockfile. The generated engine is committed as a static asset so the runtime image needs no compiler dependencies.

The Web Worker imports only compiler-generated JavaScript through a Blob module. Arbitrary source code from uploaded exports is not executed. The local server gives only the demo worker a policy allowing Blob modules, with `connect-src 'none'`. The authenticated application retains its existing policy. The demo has no destination transport, telemetry, account secrets or persistent storage.

JSON imports are bounded to 4 MB, 200 workflows and the existing 500-step-per-workflow limit. Processing has a 15-second timeout that terminates the worker. ZIP backup import remains a full-application feature. Uploaded workflows often need representative webhook inputs and response fields that generic synthetic fixtures do not provide. A held replay is preserved as an observation, not turned into a conversion claim.

## Verification

- WSL Docker regression suite passed 97/97 tests after the sample and legacy guidance fixes.
- Five browser-artifact tests compare imports, source fingerprints and generated code with the production compiler, confirm shared account identity and preserve unsupported-action blocking.
- Browser walkthrough verified required mapping review before continuation, one simulated account for three Airtable actions, successful create and update branches, redacted exact request bodies, skipped sibling steps and a held destination failure.
- Actual file chooser import of a separate synthetic Zap JSON was processed locally.
- Actual generated `workflow.mjs` download was received in the local Downloads folder.
- Downloaded JavaScript matched the production compiler output byte for byte for the reviewed sample with its shared demo account binding.
- The source explorer loaded the actual graph compiler snapshot. Fifteen source and test files are included, with no imported workflow data.
- A 390-pixel viewport check showed no horizontal document overflow in the review screen. The browser viewport was restored afterward.
- The authenticated app was checked in the browser. Connections no longer contains OAuth client configuration, and Admin settings shows provider registration controls. The temporary private login handoff file was removed.

The technical page describes the trained 7B migration proposal model but does not invoke it. Neither this demo nor mocked OAuth protocol tests establish real provider consent, token refresh, live API equivalence, durable browser recovery or production cutover readiness. Google OAuth registration remains pending.

The walkthrough was initially verified locally. It was subsequently published at [the public demo](https://zulfkicar.github.io/apps/unzap/), with source at [zulfkicar/unzap](https://github.com/zulfkicar/unzap). GitHub repository checks and the portfolio Pages deployment succeeded. The hosted importer, mapping-review flow, shared demo-account assignment and generated-code replay were verified in the browser. The portfolio and profile README now link to it.
