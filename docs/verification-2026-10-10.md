# Verification — 2026-10-10

29 tests pass on Windows Node 24 and WSL Docker. Tests execute the native generated workflow, validate exact outgoing requests, boot exported projects independently, reopen persisted journals, enforce authentication and activation gates, and exercise ZIP integrity and size limits.

The source-contract pass adds a regression based on the inspected export's dotted `message.last` / `message.create_source_id` fields and raw Slack request action. All identifiers and values are authored placeholders. It checks thread mapping, Unicode, typed references, explicit mapping approval, rejection of unsupported options, malformed Slack receipts and preservation of false/zero/null JSON request bodies.

The real supplied ZIP is tested locally with `scripts/verify-export-corpus.mjs`. All 4,083 definitions, 27,691 nodes and 1,279 branching points retain their IDs and parent links. Five workflows are structurally ready. There are 1,388 review proposals and 4,078 blocked workflows. Unsupported app actions, triggers, expressions and branch semantics remain blockers. **This is corpus structure verification, not executed migration parity.** The report is written only to ignored `.data/corpus-verification.json`.

Browser checks verify sign-in, the migration-stage controls, graph navigation, JSON-safe source-field insertion, new-version save and successful/filtered/held fixture outcomes. The current expense example passes all three behavioral fixtures after replacing its amount mapping with a modern gives reference.

The graph now renders parent-linked branches rather than representing the import as a flat linear list. The workbench has typed field selectors and stage navigation. Tests check graph preservation and HTML escaping of hostile source labels.

Desktop and 390px phone views were inspected. At the phone breakpoint the page has no horizontal overflow, and selecting a graph node reveals its editor. Small interface labels have an 11px minimum. Saved workflow version 2 and its three fixture results survived a preview rebuild and desktop app restart.

Actual provider recordings and live sandbox credentials were not supplied. Full webhook/response examples and export-derived contracts are labeled accordingly. No provider or private-source code was executed externally, and no live SaaS write or public upload occurred.
