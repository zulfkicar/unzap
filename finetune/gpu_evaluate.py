"""Complete missing comparison pairs from the existing adapter. No training."""
import json
import os
import threading
import time
from pathlib import Path

def complete(payload, output_dir, commit):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig, StoppingCriteria, StoppingCriteriaList
    from peft import PeftModel, prepare_model_for_kbit_training
    output=Path(output_dir)
    until=payload['deadline_unix']
    if time.time()>=until:
        raise RuntimeError('Evaluation authorization expired')
    threading.Thread(target=lambda:(time.sleep(max(0,until-time.time())),os._exit(124)),daemon=True).start()
    torch.set_num_threads(4)
    torch.manual_seed(20261010)
    base=Path('/artifacts/model-cache/models--Qwen--Qwen2.5-Coder-7B-Instruct/snapshots/c03e6d358207e414f1eca0bb1891e29f1db0e242')
    quant=BitsAndBytesConfig(load_in_4bit=True,bnb_4bit_quant_type='nf4',bnb_4bit_compute_dtype=torch.bfloat16,bnb_4bit_use_double_quant=True)
    model=AutoModelForCausalLM.from_pretrained(base,local_files_only=True,trust_remote_code=False,use_safetensors=True,quantization_config=quant,device_map={'':0},torch_dtype=torch.bfloat16,attn_implementation='sdpa')
    model=prepare_model_for_kbit_training(model,use_gradient_checkpointing=True,gradient_checkpointing_kwargs={'use_reentrant':False})
    model=PeftModel.from_pretrained(model,output/'adapter',is_trainable=False)
    model.eval();model.config.use_cache=True
    tokenizer=AutoTokenizer.from_pretrained(output/'adapter',local_files_only=True,trust_remote_code=False)
    generations=json.loads((output/'generations.json').read_text())
    records=generations['records']
    class Deadline(StoppingCriteria):
        def __call__(self,input_ids,scores,**kwargs):return time.time()>=until-120
    start=time.monotonic()
    def save():
        generations['status']='complete' if len(records)==len(payload['test']) and all(len(r['outputs'])==2 and not any(o['deadline_interrupted'] for o in r['outputs'].values()) for r in records) else 'partial'
        generations['evaluation_continuation_seconds']=round(time.monotonic()-start,2)
        (output/'generations.json').write_text(json.dumps(generations,indent=2));commit()
    for task in payload['test']:
        if time.time()>=until-120:break
        row=next((r for r in records if r['id']==task['id']),None)
        if row is None:
            row={k:task[k] for k in ['id','family','expected_action','branches']};row['outputs']={};records.append(row)
        for label in ['base','adapter']:
            if time.time()>=until-120:break
            old=row['outputs'].get(label)
            if old and not old['deadline_interrupted']:continue
            if old:row.setdefault('interrupted_outputs',[]).append({'model':label,**old})
            tokens=tokenizer.apply_chat_template(task['messages'],tokenize=True,add_generation_prompt=True,return_tensors='pt').to('cuda')
            tick=time.monotonic()
            def generate():
                with torch.no_grad():return model.generate(tokens,attention_mask=torch.ones_like(tokens),do_sample=False,max_new_tokens=2048,pad_token_id=tokenizer.eos_token_id,stopping_criteria=StoppingCriteriaList([Deadline()]))
            if label=='base':
                with model.disable_adapter():result=generate()
            else:result=generate()
            completion=result[0,tokens.shape[1]:]
            row['outputs'][label]={'text':tokenizer.decode(completion,skip_special_tokens=True),'tokens':len(completion),'seconds':round(time.monotonic()-tick,3),'token_limit_reached':len(completion)>=2048,'deadline_interrupted':time.time()>=until-120 and len(completion)<2048 and int(completion[-1])!=tokenizer.eos_token_id}
            print(json.dumps({'stage':'evaluation-continuation','model':label,'case':task['id'],'tokens':len(completion)}),flush=True)
        save()
    save()
    return {'status':generations['status'],'paired_cases':sum(len(r['outputs'])==2 and not any(o['deadline_interrupted'] for o in r['outputs'].values()) for r in records),'seconds':generations['evaluation_continuation_seconds']}
