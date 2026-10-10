# AutomationBench local compatibility probe

On 2026-10-10 the locally hosted Qwen2.5-Coder 7B Q4_K_M base with the Unzap F16 LoRA adapter ran through the unmodified official AutomationBench evaluation harness. This is a small public foundational compatibility probe, not an official benchmark score.

## Frozen setup

- Upstream: [zapier/AutomationBench](https://github.com/zapier/AutomationBench), commit `4a8e1061254004d9dac807054eed33fad7d1ff14`, version 1.0.6.
- Dependencies: upstream `uv.lock`, installed with `uv sync --frozen --no-dev` in Python 3.13 Docker.
- Selection: first six tasks in the public `simple` domain, in upstream order. All six involve Gmail/Salesforce updates. This is a narrow, non-random sample.
- Toolset: `limited_zapier`. Native Chat Completions tool definitions, with no output repair or JSON-to-tool-call shim.
- Model: existing local trained endpoint `unzap-7b`, four CPU threads, unchanged adapter and quantized weights.
- Limits: one concurrent task, eight response turns per task, 512 output tokens per response, temperature 0, seed 42, 15-minute outer wall-clock cap.
- Cost: no paid model calls or new cloud compute. Local inference consumes time, memory and electricity.

## Result

All six rollouts completed without API errors or empty responses. **0/6 tasks passed**, partial credit was zero, and **zero recognized tool calls** were emitted. Each task ended after one model response. Total harness time was approximately 225 seconds.

The responses described intended Gmail/Salesforce calls as plain-text JSON objects, often using placeholder IDs or invented search values. The native tool-call harness consequently executed no tools and the simulated business state stayed unchanged. This is both a protocol gap and evidence that a generated action sketch is not a completed task. The probe cannot separate training effects from base-model behavior because no base-only control was run.

The `simple` domain is excluded from the official score. The six main public domains and the separate private leaderboard set were not evaluated. Do not report this as a full AutomationBench pass rate or compare it with frontier-model leaderboard numbers. The caps also differ from full benchmark evaluation settings.

The [aggregate result](automationbench-smoke-results-2026-10-10.json) is public. Full benchmark transcripts and simulated world state remain in ignored `.data/automationbench`. No customer export was sent to the benchmark or any remote model service.

## Reproduce

Clone the pinned upstream into `.data/automationbench/upstream`, build `finetune/automationbench.Dockerfile` using that directory as the build context, then run the image on the local `unzap_default` Docker network:

```sh
docker build -f finetune/automationbench.Dockerfile -t unzap-automationbench:local .data/automationbench/upstream
timeout 900 docker run --rm --network unzap_default --memory 2g --cpus 1 \
  -e OPENAI_API_KEY=local-evaluation-placeholder \
  -v "$PWD/.data/automationbench:/results" unzap-automationbench:local \
  --model unzap-7b --base-url http://translator:11435/v1 \
  --domains simple --toolset limited_zapier --num-examples 6 \
  --max-steps 8 --max-concurrent 1 \
  --extra-body '{"max_tokens":512,"temperature":0,"seed":42}' \
  --input-cost 0 --output-cost 0 --export-json /results/simple-native.json
```

Next: compare the base model under the same protocol, verify proper tool-call serving, and evaluate a frozen, broader task sample. Keep any JSON tool-call wrapper as a separate harness condition. Agent tool-use training would be a separate experiment from the existing workflow translation adapter.
