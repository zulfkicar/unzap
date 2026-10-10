# Local workflow translator fine-tuning

This experiment teaches a small coding model to translate descriptions and Zap-shaped JSON into Unzap's supported workflow language. It trains a real LoRA adapter and compares raw base and adapter generations with the compiler and mocked execution. It does not add missing connectors or train unrestricted code execution.

The [first run report](../docs/fine-tuning-2026-10-10.md) records the result and limitations. The application still uses its existing Ollama Qwen3 4B agent. This 0.5B adapter has a compact proposal protocol and is an experimental translator, not an automatic replacement for that agent.

## Reproduce on Windows with WSL Docker

Run these from the repository root. Node 24 is used to build and score the dataset. WSL Docker provides the isolated CPU training environment. Allow roughly 1 GB for model weights and several GB for the image. Training and evaluation each have a 20-minute limit, six CPU threads and an 8 GB container memory limit.

```powershell
node finetune/build-dataset.mjs
wsl docker compose -p unzap-finetune -f finetune/compose.yaml build download
wsl docker compose -p unzap-finetune -f finetune/compose.yaml run --rm download
wsl docker compose -p unzap-finetune -f finetune/compose.yaml run --rm train
wsl docker compose -p unzap-finetune -f finetune/compose.yaml run --rm evaluate
node finetune/score.mjs
```

The downloader accesses the official public model without an authentication token. It mounts only the weights volume. Training and evaluation have no network and read-only model and dataset mounts. They write checkpoints and reports to `.data/finetune/runs/pilot-v1`. Existing adapters are protected against accidental overwrite. Preserve that directory before another run. A `STOP` file inside it stops training before the next microstep. The wall-clock limit is checked between microsteps and generation tokens, so a single operation and final saving can extend past it.

Evaluation also protects existing generations. To finish a partial run, use `wsl docker compose -p unzap-finetune -f finetune/compose.yaml run --rm evaluate python evaluate.py --resume`. It requires the same test fingerprint, case selection and token limit. Deadline-interrupted outputs remain in the audit trail and are regenerated. Interrupted pairs are excluded from scoring.

The [official Qwen base model](https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct) is pinned to revision `ea3f2471cf1b1f0db85067f1ef93848e38e88c25`. Loading uses local safetensors with remote code disabled. The Python dependencies are pinned in the Dockerfile. The Python container base tag is not digest-pinned.

## Data and target

`build-dataset.mjs` authors 120 training, 20 validation and 24 test examples. They contain fictional identifiers, domains, payloads and workflow descriptions. No customer export literals, credentials, private source code or live provider responses are training data. The examples use implemented contracts and source shapes observed during local export inspection.

The target is one JSON command: either a typed `propose` definition with a separate trigger and steps, or `inspect` for an unsupported action. Source examples must preserve IDs and parent relationships. Training uses completion-only loss and leaves all base weights frozen. Rank-16 adapters train the attention projection layers, with 2,162,688 trainable parameters.

Families cover typed mapping, normalization, filters, priority/fallback routing, Airtable lookup, UTC dates, HTTP queries, source preservation and unsupported actions. Nested routing and lookup followed by routing occur only in the test split. Familiar-family examples share templates and vary fields, thresholds, domains and IDs. This split measures a narrow translation contract, not general language understanding. Manifest fingerprints cover messages and targets, not full fixture files.

## Evaluation

The default comparison selects one case from each of 12 families, including two structurally held-out combinations. The other 12 test variants remain available for a separately recorded extension. Each model gets identical prompts, greedy decoding and a 1,024-token completion allowance. Test labels never enter prompts. There is no schema enforcement, output cleanup or repair loop.

`oracle.js` checks source topology, validates and compiles the proposed definition, then executes it against authored fixtures. It checks final outputs and exact HTTP methods, URLs and bodies. The dataset builder supplies both labels and fixture expectations, which are fixed before generation. They are not an independent human audit or recorded provider ground truth. Requests are intercepted locally. No Slack, Airtable or other provider is contacted. Refusal correctness is reported separately from executable behavior.

Reports distinguish valid JSON, accepted workflows, behavioral success, refusal success and the two structural holdouts. Read the failed cases and raw generations before using a headline rate. Validation loss covers six examples, one from each of the first six familiar families, rather than all 20 validation examples.

## Artifacts and next experiments

The adapter, tokenizer, training history, raw generations and per-case scores stay under ignored `.data/finetune`. The checkpoint is Hugging Face PEFT format. No GGUF conversion, Ollama import or application promotion is implied.

The next useful dataset needs independently written descriptions, supported real-export structures with reviewed labels, more adapter coverage, deeper unseen graph compositions and adversarial missing-field cases. Keep a frozen evaluation set outside training, compare against the current 4B agent under the same protocol, and retain compiler and behavioral gates. Fine-tuning reduces translation errors only where the runtime already has a correct implementation.
