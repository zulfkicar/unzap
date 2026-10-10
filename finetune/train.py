"""Bounded, offline completion-only CPU LoRA pilot. No remote code or data upload."""
import argparse
import hashlib
import json
import math
import random
import time
from pathlib import Path

import torch
from peft import LoraConfig, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer


def encode_examples(path, tokenizer, max_length):
    kept, excluded = [], []
    for line in path.read_text().splitlines():
        item = json.loads(line)
        prompt = tokenizer.apply_chat_template(item["messages"][:-1], tokenize=True, add_generation_prompt=True)
        full = tokenizer.apply_chat_template(item["messages"], tokenize=True, add_generation_prompt=False)
        if full[:len(prompt)] != prompt:
            raise RuntimeError("Chat-template prefix mismatch")
        if len(full) > max_length:
            excluded.append({"id": item["id"], "family": item["family"], "tokens": len(full)})
            continue
        labels = [-100] * len(prompt) + full[len(prompt):]
        if not any(v != -100 for v in labels):
            raise RuntimeError("No assistant tokens to supervise")
        kept.append({"id": item["id"], "family": item["family"], "input_ids": torch.tensor([full]), "labels": torch.tensor([labels]), "prompt_tokens": len(prompt), "completion_tokens": len(full)-len(prompt)})
    return kept, excluded


def validation_loss(model, samples):
    model.eval()
    values = []
    with torch.no_grad():
        for row in samples:
            values.append(float(model(input_ids=row["input_ids"], attention_mask=torch.ones_like(row["input_ids"]), labels=row["labels"]).loss))
    model.train()
    return sum(values) / len(values)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=64)
    parser.add_argument("--max-seconds", type=int, default=1200)
    parser.add_argument("--threads", type=int, default=6)
    parser.add_argument("--sequence-length", type=int, default=1536)
    parser.add_argument("--accumulate", type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.steps <= 128 or not 1 <= args.max_seconds <= 3600:
        raise RuntimeError("Pilot exceeds supported step/time bounds")
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    seed = 20261010
    random.seed(seed)
    torch.manual_seed(seed)
    base, dataset, out = Path("/models/base"), Path("/dataset"), Path("/runs/pilot-v1")
    out.mkdir(parents=True, exist_ok=True)
    if (out / "adapter").exists():
        raise RuntimeError("An adapter already exists. Preserve this run and choose a new run directory before retraining.")
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True, trust_remote_code=False)
    training, excluded = encode_examples(dataset / "train.jsonl", tokenizer, args.sequence_length)
    validation, validation_excluded = encode_examples(dataset / "validation.jsonl", tokenizer, args.sequence_length)
    if not training or not validation:
        raise RuntimeError("No usable split after token-length checks")
    # Select one case per familiar validation family, without using test labels.
    validation_small = list({row["family"]: row for row in validation}.values())[:6]
    model = AutoModelForCausalLM.from_pretrained(base, local_files_only=True, trust_remote_code=False, use_safetensors=True, torch_dtype=torch.float32, attn_implementation="sdpa")
    model.config.use_cache = False
    config = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules=["q_proj", "k_proj", "v_proj", "o_proj"], bias="none", task_type="CAUSAL_LM")
    model = get_peft_model(model, config)
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    trainable = [(name, parameter) for name, parameter in model.named_parameters() if parameter.requires_grad]
    if not trainable or any("lora_" not in name for name, _ in trainable):
        raise RuntimeError("Unexpected non-adapter trainable weights")
    optimizer = torch.optim.AdamW([p for _, p in trainable], lr=4e-4, weight_decay=0.01)
    report = {"status": "running", "base": json.loads((base/"download-manifest.json").read_text()), "seed": seed, "device": "cpu", "dtype": "float32", "steps_requested": args.steps, "max_seconds": args.max_seconds, "threads": args.threads, "gradient_accumulation": args.accumulate, "sequence_limit": args.sequence_length, "completion_only_loss": True, "trainable_parameters": sum(p.numel() for _, p in trainable), "total_parameters": sum(p.numel() for p in model.parameters()), "base_weights_frozen": True, "training_examples": len(training), "validation_examples": len(validation), "excluded_training": excluded, "excluded_validation": validation_excluded, "dataset": json.loads((dataset/"manifest.json").read_text()), "history": []}
    start = time.monotonic()
    initial = validation_loss(model, validation_small)
    report["validation_loss_before"] = initial
    report["validation_evaluated_examples"] = len(validation_small)
    report["lora"] = {"rank": 16, "alpha": 32, "dropout": 0.05, "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj"]}
    print(json.dumps({"stage": "ready", "trainable_parameters": report["trainable_parameters"], "examples": len(training), "max_tokens": max(len(row["input_ids"][0]) for row in training), "validation_loss": initial}), flush=True)
    model.train()
    order = list(range(len(training)))
    random.shuffle(order)
    cursor, microsteps, completed, stop_reason = 0, 0, 0, "step_limit"
    for step_number in range(args.steps):
        optimizer.zero_grad(set_to_none=True)
        losses = []
        for _ in range(args.accumulate):
            if time.monotonic()-start >= args.max_seconds or (out/"STOP").exists():
                stop_reason = "time_limit" if not (out/"STOP").exists() else "operator_stop"
                break
            row = training[order[cursor]]
            cursor += 1
            if cursor == len(order):
                cursor = 0
                random.shuffle(order)
            loss = model(input_ids=row["input_ids"], attention_mask=torch.ones_like(row["input_ids"]), labels=row["labels"]).loss
            if not torch.isfinite(loss):
                raise RuntimeError("Non-finite training loss")
            (loss / args.accumulate).backward()
            losses.append(float(loss.detach()))
            microsteps += 1
        if len(losses) != args.accumulate:
            optimizer.zero_grad(set_to_none=True)
            break
        torch.nn.utils.clip_grad_norm_([p for _, p in trainable], 1.0)
        scale = min(1.0, (step_number+1)/4) * (0.15+0.85*(1+math.cos(math.pi*step_number/args.steps))/2)
        for group in optimizer.param_groups:
            group["lr"] = 4e-4*scale
        optimizer.step()
        completed += 1
        event = {"step": completed, "loss": sum(losses)/len(losses), "elapsed_seconds": round(time.monotonic()-start,2), "learning_rate": optimizer.param_groups[0]["lr"]}
        report["history"].append(event)
        (out/"training-progress.json").write_text(json.dumps(report,indent=2))
        print(json.dumps(event), flush=True)
    if completed == 0:
        raise RuntimeError("No optimizer update completed within the resource limit")
    model.save_pretrained(out/"adapter", safe_serialization=True)
    tokenizer.save_pretrained(out/"adapter")
    report.update({"status": "trained", "steps_completed": completed, "microsteps": microsteps, "stop_reason": stop_reason, "elapsed_seconds": round(time.monotonic()-start,2), "validation_loss_after": validation_loss(model, validation_small), "adapter_sha256": hashlib.sha256((out/"adapter/adapter_model.safetensors").read_bytes()).hexdigest(), "promotion": "Not promoted. Independent generation and execution evaluation required."})
    (out/"training-report.json").write_text(json.dumps(report,indent=2))
    print(json.dumps({k:report[k] for k in ["status","steps_completed","stop_reason","elapsed_seconds","validation_loss_before","validation_loss_after","adapter_sha256"]}), flush=True)


if __name__ == "__main__":
    main()
