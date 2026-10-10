# Verification — 2026-10-07

## Automated checks

23 tests pass on Windows and WSL Docker with Node 24.15.0, including bounded ZIP imports, ambiguous file rejection, integrity checks and corrupt/truncated archives. Local HTTP integration checks require local-network permission.

The suite covers full graph preservation and blockers, reviewed proposals, typed references, filter groups, exact serialization, SaaS request/receipt contracts, import deduplication, encrypted persistence and tamper detection, concurrent duplicates, persisted idempotency, safe resume, uncertain-write reconciliation, restart recovery, auth/origin/activation gates, version pinning, and an exported project's independent boot and restart.

All provider effects use deterministic mock or injected transports. No real Slack messages, Airtable records or business API writes are issued.

## Browser checks

The local IAB preview verifies sign-in, workflow selection, generated requests and credential redaction, guided configuration, fixture outcomes and import onboarding. The file chooser initially stalled while reading a file through the browser bridge. Paste-JSON import and bounded file-read/request timeouts were added. The synthetic export also arrived through the initial file path after the stall. Normal-browser upload performance remains unmeasured.

An imported Slack workflow was approved through the UI, given an authored event and an exact request-body fixture, tested successfully, and activated in mock mode. The expense example's success, filtered and missing-data cases also pass through the UI. The 390-pixel mobile preview was checked and a grid overflow corrected. After the fix, document width matches the viewport. The viewport override was reset.

Screenshots show only original synthetic workflows. Private company values are excluded from screenshots, public fixtures and this document.

## Private inspection

A full local backup was parsed to check coverage and prioritize adapters. Only aggregate inventory is written to ignored `.data/rebuild-inventory.json`. Its definitions remain outside this repository. Structurally ready counts are not verified migration counts. Proposals need review and behavioral checks.

A second supplied ZIP was inspected directly through the new archive reader. Aggregate results are written only to ignored `.data/zip-inventory.json`. Slack/ticket workflow families expose attachment branches, custom ticket API lookups, reply delivery, delays, formatting, AI actions and mirror-record logging. These drive adapter priorities, without turning unsupported branches into executable conversions.

## Unverified

Production OAuth/resource discovery, actual API scopes and rate limits, source-to-target equivalence with original run histories, larger concurrent loads, multi-process leases, remote hardening, arbitrary-code sandboxing and complete connector coverage remain unverified. No production cutover is claimed.
