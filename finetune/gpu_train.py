"""Bounded QLoRA and paired generation. Only sanitized prompts/targets enter here."""
import hashlib
import json
import math
import os
import random
import threading
import time
from pathlib import Path


def experiment(payload, output_dir, commit):
    import torch
    from huggingface_hub import snapshot_download
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, StoppingCriteria, StoppingCriteriaList
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'report.json').exists():
        raise RuntimeError('Run already exists. Never repeat billable work implicitly.')
    deadline = payload['deadline_unix']
    if time.time() >= deadline:
        raise RuntimeError('Authorized compute window expired')
    # This absolute deadline survives transparent process replacement/preemption.
    def watchdog():
        time.sleep(max(0, deadline - time.time()))
        os._exit(124)
    threading.Thread(target=watchdog, daemon=True).start()
    seed = 20261010
    random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.set_num_threads(4)
    report = {
        'status': 'initializing', 'model': payload['model'], 'revision': payload['revision'],
        'dataset_fingerprints': payload['fingerprints'], 'seed': seed,
        'budget_usd': 15, 'deadline_unix': deadline, 'history': [],
        'lora': {'rank': 16, 'alpha': 32, 'dropout': 0.05},
        'quantization': 'NF4 4-bit, double quantization, BF16 compute',
        'protocol': 'Raw greedy generation, no schema enforcement or repair. Test labels are absent from the uploaded test prompts.',
    }
    start = time.monotonic()
    generations = {'status': 'partial', 'records': []}
    def save():
        report['elapsed_seconds'] = round(time.monotonic() - start, 2)
        (output / 'report.json').write_text(json.dumps(report, indent=2))
        (output / 'generations.json').write_text(json.dumps(generations, indent=2))
        commit()
    save()
    base = snapshot_download(
        payload['model'], revision=payload['revision'], token=False,
        cache_dir='/artifacts/model-cache',
        allow_patterns=['*.json', '*.safetensors', '*.txt', '*.model', 'LICENSE', 'README.md'],
    )
    tokenizer = AutoTokenizer.from_pretrained(base, local_files_only=True, trust_remote_code=False)
    quant = BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type='nf4', bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
    model = AutoModelForCausalLM.from_pretrained(
        base, local_files_only=True, trust_remote_code=False, use_safetensors=True,
        quantization_config=quant, device_map={'': 0}, torch_dtype=torch.bfloat16,
        attn_implementation='sdpa',
    )
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True, gradient_checkpointing_kwargs={'use_reentrant': False})
    targets = ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj']
    model = get_peft_model(model, LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, target_modules=targets, bias='none', task_type='CAUSAL_LM'))
    trainable = [(n, p) for n, p in model.named_parameters() if p.requires_grad]
    if not trainable or any('lora_' not in n for n, _ in trainable):
        raise RuntimeError('Non-adapter weights unexpectedly trainable')
    report['trainable_parameters'] = sum(p.numel() for _, p in trainable)
    report['gpu'] = torch.cuda.get_device_name(0)
    report['target_modules'] = targets

    def encode(rows):
        accepted, excluded = [], []
        for row in rows:
            full = tokenizer.apply_chat_template(row['messages'], tokenize=True, add_generation_prompt=False)
            prefix = tokenizer.apply_chat_template(row['messages'][:-1], tokenize=True, add_generation_prompt=True)
            if full[:len(prefix)] != prefix:
                raise RuntimeError('Chat prefix does not match completion-only target')
            if len(full) > 4096:
                excluded.append(row['id'])
                continue
            accepted.append({**row, 'tokens': full, 'prefix_length': len(prefix)})
        return accepted, excluded

    training, excluded = encode(payload['train'])
    validation, validation_excluded = encode(payload['validation'])
    if not training or not validation:
        raise RuntimeError('Empty usable training or validation set')
    report.update({'training_examples': len(training), 'validation_examples': len(validation), 'excluded_training': excluded, 'excluded_validation': validation_excluded, 'max_sequence_length': 4096, 'completion_only_loss': True})
    chosen = []
    for pool, limit in [(list(filter(lambda r: r['branches'] > 0, validation)), 8), (validation, 16)]:
        for row in pool:
            if row['family'] not in {r['family'] for r in chosen}:
                chosen.append(row)
                if len(chosen) >= limit:
                    break
    report['validation_loss_case_ids'] = [r['id'] for r in chosen]

    def batch(rows):
        length = max(len(r['tokens']) for r in rows)
        ids = torch.full((len(rows), length), tokenizer.eos_token_id, dtype=torch.long, device='cuda')
        labels = torch.full_like(ids, -100)
        mask = torch.zeros_like(ids)
        for i, row in enumerate(rows):
            n, p = len(row['tokens']), row['prefix_length']
            ids[i, :n] = torch.tensor(row['tokens'], device='cuda')
            labels[i, p:n] = ids[i, p:n]
            mask[i, :n] = 1
        return {'input_ids': ids, 'labels': labels, 'attention_mask': mask}

    def validation_loss():
        model.eval()
        with torch.no_grad(), torch.autocast('cuda', dtype=torch.bfloat16):
            values = [float(model(**batch([r])).loss) for r in chosen]
        return sum(values) / len(values)

    class Deadline(StoppingCriteria):
        def __init__(self, until):
            self.until = until
        def __call__(self, input_ids, scores, **kwargs):
            return time.time() >= self.until

    def evaluate(label, tasks, seconds):
        until = min(deadline - 180, time.time() + seconds)
        model.eval()
        model.config.use_cache = True
        for task in tasks:
            if time.time() >= until:
                break
            row = next((r for r in generations['records'] if r['id'] == task['id']), None)
            if row is None:
                row = {k: task[k] for k in ['id', 'family', 'expected_action', 'branches']}
                row['outputs'] = {}
                generations['records'].append(row)
            if label in row['outputs']:
                continue
            tokens = tokenizer.apply_chat_template(task['messages'], tokenize=True, add_generation_prompt=True, return_tensors='pt').to('cuda')
            tick = time.monotonic()
            def generate():
                with torch.no_grad():
                    return model.generate(tokens, attention_mask=torch.ones_like(tokens), do_sample=False, max_new_tokens=2048, pad_token_id=tokenizer.eos_token_id, stopping_criteria=StoppingCriteriaList([Deadline(until)]))
            if label == 'base':
                with model.disable_adapter():
                    result = generate()
            else:
                result = generate()
            completion = result[0, tokens.shape[1]:]
            interrupted = time.time() >= until and len(completion) < 2048 and int(completion[-1]) != tokenizer.eos_token_id
            row['outputs'][label] = {'text': tokenizer.decode(completion, skip_special_tokens=True), 'tokens': len(completion), 'seconds': round(time.monotonic()-tick, 3), 'token_limit_reached': len(completion) >= 2048, 'deadline_interrupted': interrupted}
            if len(generations['records']) % 10 == 0:
                save()
            print(json.dumps({'stage': label, 'case': task['id'], 'tokens': len(completion)}), flush=True)
        save()

    report['status'] = 'baseline'
    report['test_case_ids'] = [r['id'] for r in payload['test']]
    save()
    evaluate('base', payload['test'], 1800)
    report['validation_loss_before'] = validation_loss()
    report['status'] = 'training'
    model.config.use_cache = False
    model.train()
    optimizer = torch.optim.AdamW([p for _, p in trainable], lr=2e-4, weight_decay=0.01, fused=True)
    weighted = list(range(len(training))) + [i for i, r in enumerate(training) if r['branches'] > 0] * 3
    order, cursor, visited = [], 0, set()
    def refresh():
        random.shuffle(weighted)
        # Small length buckets reduce padding without fixing curriculum order.
        return [i for j in range(0, len(weighted), 32) for i in sorted(weighted[j:j+32], key=lambda k: len(training[k]['tokens']))]
    order = refresh()
    train_end = min(time.time()+7200, deadline-2100)
    for step in range(600):
        if time.time() >= train_end:
            report['stop_reason'] = 'training_time_limit'
            break
        optimizer.zero_grad(set_to_none=True)
        losses, interrupted = [], False
        for _ in range(4):
            if time.time() >= train_end:
                interrupted = True
                break
            rows = []
            for _ in range(2):
                if cursor >= len(order):
                    order, cursor = refresh(), 0
                index = order[cursor]
                cursor += 1
                visited.add(training[index]['id'])
                rows.append(training[index])
            with torch.autocast('cuda', dtype=torch.bfloat16):
                loss = model(**batch(rows)).loss
            if not torch.isfinite(loss):
                raise RuntimeError('Non-finite training loss')
            (loss / 4).backward()
            losses.append(float(loss.detach()))
        if interrupted:
            optimizer.zero_grad(set_to_none=True)
            report['stop_reason'] = 'training_time_limit'
            break
        torch.nn.utils.clip_grad_norm_([p for _, p in trainable], 1)
        scale = min(1, (step+1)/10) * (0.2+0.8*(1+math.cos(math.pi*step/600))/2)
        for group in optimizer.param_groups:
            group['lr'] = 2e-4 * scale
        optimizer.step()
        event = {'step': step+1, 'loss': sum(losses)/len(losses), 'seconds': round(time.monotonic()-start, 2)}
        report['history'].append(event)
        if (step+1) % 10 == 0:
            report['unique_training_examples_visited'] = len(visited)
            save()
            print(json.dumps({'stage': 'training', **event}), flush=True)
    if not report['history']:
        raise RuntimeError('Budget expired before any training update')
    report.setdefault('stop_reason', 'step_limit')
    report['steps_completed'] = len(report['history'])
    report['unique_training_examples_visited'] = len(visited)
    model.peft_config['default'].base_model_name_or_path = payload['model']
    model.peft_config['default'].revision = payload['revision']
    model.save_pretrained(output/'adapter', safe_serialization=True)
    tokenizer.save_pretrained(output/'adapter')
    report['adapter_sha256'] = hashlib.sha256((output/'adapter/adapter_model.safetensors').read_bytes()).hexdigest()
    report['validation_loss_after'] = validation_loss()
    report['status'] = 'adapter_evaluation'
    save()
    completed = {r['id'] for r in generations['records'] if r['outputs'].get('base') and not r['outputs']['base']['deadline_interrupted']}
    evaluate('adapter', [t for t in payload['test'] if t['id'] in completed], 1800)
    paired = [r for r in generations['records'] if len(r['outputs']) == 2 and not any(o['deadline_interrupted'] for o in r['outputs'].values())]
    generations['status'] = 'complete' if len(paired) == len(payload['test']) else 'partial'
    report.update({'status': 'trained', 'paired_cases': len(paired), 'generation_status': generations['status'], 'peak_gpu_allocated_gib': round(torch.cuda.max_memory_allocated()/2**30, 2), 'promotion': 'Not promoted. Local source-control and receipt scoring still required.'})
    save()
    return {'status': report['status'], 'steps': report['steps_completed'], 'paired_cases': len(paired), 'elapsed_seconds': report['elapsed_seconds']}
