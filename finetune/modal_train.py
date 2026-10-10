"""One explicitly budgeted GPU invocation. No private exports are mounted."""
import hashlib
import json
import time
from pathlib import Path

import modal

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / '.data/finetune/dataset-7b-frozen-20261010'
RUN = 'qwen7b-20261010-v2'
VOLUME_NAME = 'unzap-qwen7b-20261010-v1'
volume = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)
image = (
    modal.Image.debian_slim(python_version='3.13')
    .pip_install('torch==2.8.0', 'transformers==4.57.6', 'peft==0.18.1', 'bitsandbytes==0.48.2', 'accelerate==1.11.0', 'safetensors==0.7.0')
    .env({'HF_HUB_DISABLE_TELEMETRY': '1', 'TOKENIZERS_PARALLELISM': 'false', 'HF_HOME': '/artifacts/model-cache', 'WANDB_DISABLED': 'true'})
    .add_local_file(ROOT/'finetune/gpu_train.py', '/opt/experiment/gpu_train.py', copy=True)
)
app = modal.App('unzap-qwen7b-budget15', include_source=False)

@app.function(image=image, gpu='L40S', cpu=(2, 4), memory=(16384, 32768), volumes={'/artifacts': volume}, timeout=14400, startup_timeout=900, retries=0, max_containers=1, min_containers=0, scaledown_window=2, single_use_containers=True, include_source=False, serialized=True)
def train(payload):
    import sys
    sys.path.insert(0, '/opt/experiment')
    from gpu_train import experiment
    return experiment(payload, '/artifacts/'+RUN, volume.commit)

def read_split(name):
    return [json.loads(line) for line in (DATA/(name+'-upload.jsonl')).read_text(encoding='utf-8').splitlines()]

def prepare():
    manifest = json.loads((DATA/'manifest.json').read_text())
    if not manifest['sanitization']['passed']:
        raise RuntimeError('Sanitization audit missing')
    audit = json.loads((DATA/'upload-audit.json').read_text())
    if not audit['passed'] or audit['counts'] != {k:v['examples'] for k,v in manifest['counts'].items()}:
        raise RuntimeError('Post-augmentation upload audit missing')
    splits = {k: read_split(k) for k in ['train', 'validation', 'test']}
    families = {k: {r['family'] for r in rows} for k, rows in splits.items()}
    if families['train'] & (families['validation'] | families['test']) or families['validation'] & families['test']:
        raise RuntimeError('Graph-family leakage')
    for k in splits:
        actual = hashlib.sha256((DATA/(k+'-upload.jsonl')).read_bytes()).hexdigest()
        if actual != manifest['fingerprints'][k]:
            raise RuntimeError('Dataset fingerprint mismatch')
    selected = [r for r in splits['test'] if r['branches'] > 0]
    for pool, limit in [(list(filter(lambda r: r['expected_action']=='propose', splits['test'])), 80), (list(filter(lambda r: r['expected_action']=='inspect', splits['test'])), 100)]:
        for row in pool:
            if row['id'] not in {r['id'] for r in selected}:
                selected.append(row)
                if len(selected) >= limit:
                    break
    # Test answers and local fixtures are deliberately absent from cloud payload.
    prompts = [{**r, 'messages': r['messages'][:-1]} for r in selected]
    payload = {'model':'Qwen/Qwen2.5-Coder-7B-Instruct', 'revision':'c03e6d358207e414f1eca0bb1891e29f1db0e242', 'train':splits['train'], 'validation':splits['validation'], 'test':prompts, 'fingerprints':manifest['fingerprints']}
    run_dir = ROOT/'.data/finetune/runs'/RUN
    run_dir.mkdir(parents=True, exist_ok=True)
    code_manifest = run_dir/'oracle-code-manifest.json'
    if not code_manifest.exists():
        files = ['finetune/export-oracle.js','finetune/protocol.js','src/migration.js','src/graph-compiler.js','src/runtime.js','src/logic.js','src/dates.js','src/import-adapters.js','src/extended-adapters.js','src/importer.js']
        code_manifest.write_text(json.dumps({p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in files},indent=2))
    payload_path = run_dir/'cloud-payload.json'
    payload_path.write_text(json.dumps(payload), encoding='utf-8')
    budget = {
        'authorization_usd':15, 'gpu':'L40S', 'max_containers':1, 'automatic_retries':0,
        'gpu_function_timeout_seconds':14400, 'absolute_window_seconds':13500,
        'cpu_limit':4, 'memory_limit_gib':32,
        'reference_rates_per_second':{'L40S':0.000542,'cpu_core':0.0000131,'memory_gib':0.00000222},
        'four_hour_gpu_cpu_memory_ceiling_usd': round(14400*(0.000542+4*0.0000131+32*0.00000222),2),
        'setup_storage_network_reserve_usd':5.4,
        'reserve_includes':'The cancelled initialization and two image-build attempts are included in this reserve, not added to the $15 authorization.',
        'pricing_source':'https://modal.com/pricing',
        'account_baseline_metered_cost_usd':'1.78953889',
        'billing_note':'Reference-rate resource ceiling, not an invoice. Final account billing may lag. No serving endpoint or repeated GPU job is configured.',
        'cleanup':'Download and hash-check all run artifacts before deleting the temporary run volume.',
        'dataset_counts':manifest['counts'], 'test_cases_selected':len(prompts),
        'test_branch_cases':sum(r['branches']>0 for r in prompts),
        'payload_sha256':hashlib.sha256(payload_path.read_bytes()).hexdigest(),
    }
    (run_dir/'budget-plan.json').write_text(json.dumps(budget, indent=2))
    print(json.dumps(budget, indent=2))
    return payload, run_dir

@app.local_entrypoint()
def main(prepare_only: bool = False):
    payload, run_dir = prepare()
    if prepare_only:
        return
    labels = json.loads((run_dir/'label-verification-v2.json').read_text())
    if not labels['passed'] or any(labels['counts'][k]['positive_labels_checked'] != json.loads((DATA/'manifest.json').read_text())['counts'][k]['positive'] for k in ['train','validation','test']):
        raise RuntimeError('Verify all frozen positive labels before paid work')
    reservation = run_dir/'launch-reservation.json'
    if reservation.exists():
        raise RuntimeError('A launch is already reserved. Inspect its outcome before any further paid work.')
    payload['deadline_unix'] = time.time()+13500
    reservation.write_text(json.dumps({'reserved_usd':15,'started_unix':time.time(),'absolute_deadline_unix':payload['deadline_unix'],'app_id':app.app_id,'volume':VOLUME_NAME},indent=2))
    result = train.remote(payload)
    (run_dir/'remote-result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
    for filename in ['report.json','generations.json']:
        with (run_dir/filename).open('wb') as target:
            for chunk in volume.read_file(RUN+'/'+filename):
                target.write(chunk)
    print('Downloaded reports. Checkpoint retrieval and local behavioral scoring follow separately.')

if __name__ == '__main__':
    prepare()
