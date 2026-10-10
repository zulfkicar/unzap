"""Raw, greedy base-versus-adapter generation on the same untouched test cases."""
import argparse
import json
import time
from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer, StoppingCriteria, StoppingCriteriaList


class Deadline(StoppingCriteria):
    def __init__(self, end):
        self.end = end

    def __call__(self, input_ids, scores, **kwargs):
        return time.monotonic() >= self.end


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--limit",type=int,default=12)
    p.add_argument("--threads",type=int,default=6)
    p.add_argument("--max-seconds",type=int,default=1200)
    p.add_argument("--max-new-tokens",type=int,default=1024)
    p.add_argument("--resume",action="store_true")
    args=p.parse_args()
    if not 1 <= args.limit <= 24 or not 1 <= args.max_seconds <= 3600 or not 1 <= args.max_new_tokens <= 1536 or not 1 <= args.threads <= 8:
        raise ValueError("Evaluation exceeds supported resource bounds")
    torch.set_num_threads(args.threads);torch.set_num_interop_threads(1)
    base,run=Path('/models/base'),Path('/runs/pilot-v1')
    tokenizer=AutoTokenizer.from_pretrained(run/'adapter',local_files_only=True,trust_remote_code=False)
    model=AutoModelForCausalLM.from_pretrained(base,local_files_only=True,trust_remote_code=False,use_safetensors=True,torch_dtype=torch.float32,attn_implementation='sdpa')
    model=PeftModel.from_pretrained(model,run/'adapter',is_trainable=False)
    model.eval();model.config.use_cache=True
    tasks=[json.loads(line) for line in Path('/dataset/test.jsonl').read_text().splitlines()]
    first,remaining,seen=[],[],set()
    for task in tasks:
        if task['family'] in seen:remaining.append(task)
        else:first.append(task);seen.add(task['family'])
    selected=(first+remaining)[:args.limit]
    output_path=run/'generations.json'
    records=[];previous_seconds=0
    if args.resume:
        saved=json.loads(output_path.read_text())
        training=json.loads((run/'training-report.json').read_text())
        manifest=json.loads(Path('/dataset/manifest.json').read_text())
        if training['dataset']['fingerprints']['test'] != manifest['fingerprints']['test']:
            raise ValueError("Test split changed since training")
        if saved['cases_requested'] != len(selected) or saved['max_new_tokens'] != args.max_new_tokens:
            raise ValueError("Resume requires identical selection and token limit")
        records=saved['records'];previous_seconds=saved['elapsed_seconds']
        for row in records:
            for label, output in list(row['outputs'].items()):
                if output.get('deadline_interrupted'):
                    row.setdefault('interrupted_outputs',[]).append({'model':label,**output})
                    del row['outputs'][label]
        expected={t['id']:t['family'] for t in selected}
        if any(expected.get(r['id']) != r['family'] for r in records):
            raise ValueError("Resume task identity changed")
    elif output_path.exists():
        raise ValueError("Generations already exist. Use --resume to complete missing pairs, or preserve the run before evaluating again.")
    start=time.monotonic();end=start+args.max_seconds
    report={'status':'partial','protocol':'Greedy raw generation, no schema decoder, no repair loop, same prompts and token limits, same frozen base weights with adapter toggled. Test labels never enter model prompts.','cases_requested':len(selected),'max_new_tokens':args.max_new_tokens,'max_seconds':args.max_seconds,'elapsed_seconds':previous_seconds,'records':records}
    for task in selected:
        row=next((r for r in records if r['id']==task['id']),None)
        if row is not None and len(row['outputs'])==2:continue
        if time.monotonic()>=end:break
        prompt=tokenizer.apply_chat_template(task['messages'][:-1],tokenize=True,add_generation_prompt=True,return_tensors='pt')
        if row is None:
            row={'id':task['id'],'family':task['family'],'structural_holdout':task['structural_holdout'],'outputs':{}}
            records.append(row)
        for label in ['base','adapter']:
            if label in row['outputs']:continue
            if time.monotonic()>=end:break
            t=time.monotonic()
            def generate():
                with torch.no_grad():
                    return model.generate(prompt,attention_mask=torch.ones_like(prompt),max_new_tokens=args.max_new_tokens,do_sample=False,pad_token_id=tokenizer.eos_token_id,stopping_criteria=StoppingCriteriaList([Deadline(end)]))
            if label=='base':
                with model.disable_adapter():out=generate()
            else:out=generate()
            completion=out[0,prompt.shape[-1]:]
            interrupted=time.monotonic()>=end and len(completion)<args.max_new_tokens and int(completion[-1])!=tokenizer.eos_token_id
            row['outputs'][label]={'text':tokenizer.decode(completion,skip_special_tokens=True),'tokens':len(completion),'seconds':round(time.monotonic()-t,3),'token_limit_reached':len(completion)>=args.max_new_tokens,'deadline_interrupted':interrupted}
            print(json.dumps({'id':task['id'],'model':label,'tokens':len(completion),'seconds':row['outputs'][label]['seconds']}),flush=True)
            report.update({'status':'complete' if len(records)==len(selected) and all(len(r['outputs'])==2 and not any(o.get('deadline_interrupted') for o in r['outputs'].values()) for r in records) else 'partial','elapsed_seconds':round(previous_seconds+time.monotonic()-start,2)})
            output_path.write_text(json.dumps(report,indent=2))
        if time.monotonic()>=end:break
    report['status']='complete' if len(records)==len(selected) and all(len(r['outputs'])==2 and not any(o.get('deadline_interrupted') for o in r['outputs'].values()) for r in records) else 'partial'
    output_path.write_text(json.dumps(report,indent=2))
    print(json.dumps({'status':report['status'],'paired_cases':sum(len(r['outputs'])==2 for r in records),'elapsed_seconds':report['elapsed_seconds']}),flush=True)


if __name__=='__main__':main()
