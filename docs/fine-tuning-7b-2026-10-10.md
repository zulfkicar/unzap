# Unzap 7B export-translation experiment

The 7B QLoRA training and full 100-pair comparison are complete. The tuned translator passes **78/80 conversion tasks**, **19/20 unsupported-action tasks**, and **32/33 branch tasks**. The latest recorded workspace metered increase is **$6.78**, within the authorized $15 budget. Both apps are stopped and the temporary volume has been deleted after artifact verification. The checkpoint remains an experimental translator and has not replaced the application's 4B agent.

## Results

| Measure | Frozen 7B base, raw | Same base + LoRA, raw | Base, fence-only diagnostic |
| --- | ---: | ---: | ---: |
| JSON validity | 0/100 | 99/100 | 93/100 |
| Compiler acceptance, conversion tasks | 0/80 | 78/80 | 2/80 |
| Complete conversion task success | 0/80 | 78/80 | 0/80 |
| Branch task success | 0/33 | 32/33 | 0/33 |
| Unseen-control branch task success | 0/18 | 18/18 | 0/18 |
| Correct unsupported-action inspection | 0/20 | 19/20 | 3/20 |
| Overall task success | 0/100 | 97/100 | 3/100 |

The tuned proposals pass 294 of 300 authored execution fixtures. Each conversion task passes only if all its fixtures and structural/lineage checks pass. The 18 unseen-control examples contain six distinct control-pattern fingerprints, with three payload/identifier variants per pattern. These are not 18 independent business processes. The other 15 branch cases have familiar control patterns. This is a narrow, deterministic contract benchmark on sanitized exports and explicitly marked segments, not a population accuracy estimate, live provider comparison or benchmark against the current 4B application agent.

The raw baseline primarily emits Markdown-wrapped JSON. The separately reported fence-only diagnostic removes that wrapper without editing the workflow. Its failure to pass conversion checks shows the measured improvement includes native contract learning rather than only formatting.

Three tuned failures remain unchanged:

- `test-2b2705dae3f9-1`: a rule branch omits its comparison operator. The compiler rejects the proposal.
- `test-42f3dfcc68cd-0`: a larger linear workflow exhausts the 2,048-token completion allowance and leaves malformed JSON.
- `test-558060fe55e8-0`: the model proposes a workflow where inspection is required for an unsupported source action. This false proposal is why source-support checks must remain authoritative.

The [structured results](fine-tuning-7b-results-2026-10-10.json) retain the complete summary. Exact generations, per-case fixture results, initial comparison results, checkpoint hashes and all failed cases remain in the ignored local run folder.

## Data

The source archive contains 4,083 workflows. Sanitization preserves protocol vocabulary and graph relationships while replacing custom keys, values, source IDs, endpoints, workflow names and credentials. Unknown/private application actions and code become opaque unsupported nodes. Filter-group identities are renamed consistently, preserving their AND/OR partitions. Unparsed formulas remain unsupported rather than becoming apparently valid database queries.

The frozen dataset contains:

| Split | Examples | Supported proposals | Inspect responses | Branch examples |
| --- | ---: | ---: | ---: | ---: |
| Training | 3,588 | 3,088 | 500 | 232 |
| Validation | 188 | 138 | 50 | 12 |
| Test | 218 | 168 | 50 | 33 |

These are synthetic payload/identifier variants of sanitized structures, not thousands of independent customer workflows. Positive templates include 42 deduplicated full-export structures and 446 explicitly marked supported segments. Segments retain their descendant graphs and use a synthetic webhook to provide omitted ancestor outputs. They are not labeled as full workflow migrations.

All variants of a normalized graph family stay in one split. Branch families use a 70/10/20 hash allocation, with 80/10/10 for other families. The post-augmentation allowlist audit passes for all 3,994 examples, and there is no family overlap across splits. Oversized graphs, unsupported segments, pairs that disagree with the reference interpreter, and rule branches without an exercising fixture are excluded from positive labels.

A second, more conservative audit ignores payload shapes, names and literals, normalizes group identities and branch order, and compares canonical control trees. Of the 33 held-out branch examples, 18 have control patterns absent from eligible training and 15 have familiar patterns. Those groups are reported separately. Dataset-family separation alone is not presented as proof that every evaluation control pattern is new.

## What the branch oracle checks

A separate source-tree interpreter computes expected execution order, branch decisions, skipped descendants, per-step outputs and action receipts from sanitized source nodes. The native compiler then executes the target against those expectations. Action receipts compare integration kind and resolved parameters, including HTTP method, destination, body and typed values. Canonical reference-lineage and formatter-contract checks also reject constant substitutions and swapped mappings that sparse payloads might otherwise miss. Integration responses are authored mocks.

Before any optimizer updates, every frozen positive target was reverified under these stronger checks: 3,394 targets across 7,318 fixtures passed. The frozen messages and targets did not change. Initial and revised oracle/runtime fingerprints are retained in the run directory.

The oracle shares scalar reference parsing/resolution and formatter codecs with the runtime. It is an independent control-flow implementation, not an independent implementation of every integration. It does not establish equivalence to recorded Zapier runs or live Slack/Airtable behavior.

Regression checks cover grouped AND/OR conditions, multiple matching branches, inner and outer fallback, always branches, branch-local filter stops, source identity, order and request mutations. Privacy tests cover PII, credentials, private code, custom keys and ambiguous copied-step aliases.

## Model and compute

- Official `Qwen/Qwen2.5-Coder-7B-Instruct`, revision `c03e6d358207e414f1eca0bb1891e29f1db0e242`.
- QLoRA with frozen NF4 4-bit base weights and BF16 compute.
- Rank 16, alpha 32, dropout 0.05, attention and feed-forward projection adapters.
- Completion-only loss, sequences up to 4,096 tokens. No completion truncation.
- Batch two, four gradient-accumulation microsteps. Maximum 600 optimizer steps or two hours of training, whichever comes first.
- Branch examples receive three additional occurrences in each shuffled training order. Reports retain usable and excluded counts and the number of unique examples visited.
- One L40S, CPU limit four physical cores, hard RAM limit 32 GiB, zero automatic retries, one container, no persistent serving endpoint.

All 600 optimizer updates completed. The run trained 40,370,176 adapter parameters and visited every one of the 3,446 usable training examples. Completion-only validation loss on the recorded 16-case validation subset fell from **1.047918 to 0.152598**. This loss does not measure task success and is reported separately from execution results. The main job lasted 7,721.23 worker seconds including baseline generation, training, saving and its initial comparison. The evaluation-only continuation took 3,310.08 seconds after model setup.

The 161,533,192-byte adapter SHA-256 is `79e4c915891d43417bf08b81cb5a6841f34fa862f5d9d47a018188d64c74f907`. Twelve downloaded run artifacts passed hash verification. The checkpoint is Hugging Face PEFT format, with the official base model ID and revision recorded for subsequent loading. No GGUF/Ollama serving integration or production deployment is claimed.

The application continues to use its existing pretrained 4B agent. This experiment trains a compact translator protocol. It must pass behavioral evaluation before any application integration.

## Evaluation and budget

The fixed generation comparison selects 100 held-out cases: all 33 branch cases, another 47 supported proposals and 20 unsupported cases. Test answers and execution fixtures stay local. Only test prompts are uploaded. The base and adapter use identical greedy generation with a 2,048-token completion allowance, without schema enforcement or repair. Deadline-interrupted pairs are excluded from scoring. A separately labeled post-hoc diagnostic removes only an enclosing Markdown JSON fence, identically for both models. It does not repair syntax or workflow content and does not replace the primary raw-output scores.

Tokenization accepted 3,446 training examples and 182 validation examples. The remaining 142 training and six validation examples exceeded the 4,096-token sequence limit and were excluded rather than truncated. Actual visits and completed optimizer steps are recorded by the worker.

Each inference phase is bounded to 30 minutes. The GPU function has a four-hour timeout and an absolute 3.75-hour expiry. Published L40S, CPU and RAM reference rates give a four-hour resource ceiling of **$9.58**, with **$5.40 reserved for setup, cancelled initialization, storage and network**. This is a conservative allocation, not a final invoice. The measured account baseline was $1.78953889 in metered monthly usage and zero invoiced charges. Billing can lag.

If inference reaches its phase cap, an evaluation-only continuation can complete missing pairs from the existing, verified checkpoint. It cannot retrain or replace completed responses. Its 90-minute function limit plus a 15-minute startup allowance adds at most **$4.19** in reference-rate GPU, CPU and RAM costs. The combined main and continuation resource ceiling is **$13.78**, leaving approximately **$1.22** for setup, cancelled initialization, storage and network within the same $15 authorization. The observed initial setup and cancelled initialization increment was about $0.12 before the main run.

Two image setup attempts preceded the GPU run, including a Windows UTF-8 fix and a Python version alignment. The initial GPU attempt was stopped in initialization with zero optimizer updates after the filter-group identity issue was found. Its report and reservation remain in the ignored run directory. Setup and that initialization are included within the same $15 authorization.

The latest billing snapshot records workspace metered usage rising from $1.78953889 to $8.57086700, an increase of **$6.78132811**, and zero invoiced charges after credit adjustments. It is a workspace snapshot rather than a final per-app invoice and can lag. Both experiment apps were verified stopped with zero tasks. The temporary `unzap-qwen7b-20261010-v1` volume was deleted only after all 12 artifacts, including the adapter and tokenizer, were downloaded and hash-checked. No ongoing serving endpoint or experiment storage remains on Modal.

## Local commands and artifacts

```powershell
node finetune/build-export-dataset.mjs /path/to/private-export.zip
node finetune/audit-export-dataset.mjs
python finetune/modal_train.py
node finetune/verify-frozen-labels.mjs
# One paid launch only, after reviewing budget-plan.json
python -X utf8 -m modal run finetune/modal_train.py
python -X utf8 finetune/fetch_modal_artifacts.py
node finetune/audit-control-families.mjs
node finetune/score-export-model.mjs
```

The builder and launcher protect existing datasets and launch reservations from overwrite. Do not relaunch a reserved run to retrieve its output. `fetch_modal_artifacts.py` starts no compute and verifies the checkpoint hash. The listed fetch commands apply before cleanup. This completed run is already saved locally and its cloud volume has been removed. The only mounted source files are the training/evaluation implementations. Private export paths, raw ZIP content and local fixture files are not uploaded.

If the saved generation report is partial, review `modal_evaluate.py` and the budget allocation, then run `python -X utf8 -m modal run finetune/modal_evaluate.py` once after checkpoint verification. Download and score again afterward. It protects its own launch reservation and preserves interrupted responses in the audit trail.

Artifacts stay under `.data/finetune/runs/qwen7b-20261010-v2`, with the dataset under `.data/finetune/dataset-7b-frozen-20261010`. These paths are ignored by Git. After all artifacts are downloaded and hash-checked, the temporary Modal volume can be deleted to avoid ongoing storage costs. No GitHub or model-hub publication is authorized by this training request.
