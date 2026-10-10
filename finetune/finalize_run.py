"""Verify saved artifacts, record final billing/status, optionally remove own volume."""
import argparse
import hashlib
import json
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
RUN=ROOT/'.data/finetune/runs/qwen7b-20261010-v2'
VOLUME='unzap-qwen7b-20261010-v1'
APPS={'ap-Ditg6bZXUsPRZHH4O6rLKq','ap-mdzRxOmrkcmuylUIhGWZ0S'}

def cli(*args):
    return subprocess.run([sys.executable,'-X','utf8','-m','modal',*args],check=True,capture_output=True,text=True,encoding='utf-8').stdout

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--cleanup',action='store_true')
    args=parser.parse_args()
    training=json.loads((RUN/'report.json').read_text())
    evaluation=json.loads((RUN/'evaluation-report.json').read_text())
    if training['status']!='trained' or evaluation['status']!='complete' or evaluation['paired_cases']!=100:
        raise RuntimeError('Require trained checkpoint and complete 100-pair evaluation')
    downloads=json.loads((RUN/'download-manifest.json').read_text())
    for artifact in downloads:
        target=(RUN/artifact['path']).resolve()
        if not target.is_relative_to(RUN.resolve()):raise RuntimeError('Invalid artifact path')
        if hashlib.sha256(target.read_bytes()).hexdigest()!=artifact['sha256']:
            raise RuntimeError('Artifact changed since download: '+artifact['path'])
    adapter=RUN/'adapter/adapter_model.safetensors'
    if hashlib.sha256(adapter.read_bytes()).hexdigest()!=training['adapter_sha256']:
        raise RuntimeError('Checkpoint hash mismatch')
    apps=json.loads(cli('app','list','--json'))
    own=[a for a in apps if a['app_id'] in APPS]
    if any(a['state']!='stopped' or int(a['tasks']) for a in own):raise RuntimeError('Compute still active')
    (RUN/'shutdown-verification.json').write_text(json.dumps({'passed':True,'apps':own},indent=2))
    billing=json.loads(cli('billing','summary','--json'))
    (RUN/'billing-final-snapshot.json').write_text(json.dumps(billing,indent=2))
    delta=Decimal(billing['metered_cost'])-Decimal('1.78953889')
    budget={'authorized_usd':15,'starting_workspace_metered_usd':'1.78953889','final_workspace_metered_usd':billing['metered_cost'],'recorded_metered_increase_usd':str(delta),'workspace_invoiced_usd':billing['billed_cost'],'billing_note':'Workspace snapshot, not a final per-app invoice. Metering can lag. Resource ceilings also stayed below authorization.','checkpoint_sha256':training['adapter_sha256'],'local_artifacts_verified':len(downloads),'cloud_volume_deleted':False}
    if delta>15:raise RuntimeError('Recorded metered increase exceeds budget')
    if args.cleanup:
        cli('volume','delete','--yes',VOLUME)
        budget['cloud_volume_deleted']=True
        budget['deleted_volume']=VOLUME
    (RUN/'completion-verification.json').write_text(json.dumps(budget,indent=2))
    public={'date':'2026-10-10','model':training['model'],'revision':training['revision'],'steps':training['steps_completed'],'trainable_parameters':training['trainable_parameters'],'training_examples':training['training_examples'],'validation_loss_before':training['validation_loss_before'],'validation_loss_after':training['validation_loss_after'],'adapter_sha256':training['adapter_sha256'],'evaluation':{k:v for k,v in evaluation.items() if k not in ['rows','available_unpaired']},'budget':budget,'promotion':'Experimental translator. Not installed as the application agent. One unsupported-action false proposal and one token-capped conversion remain failures. All compiler and source-preservation gates remain required.'}
    (ROOT/'docs/fine-tuning-7b-results-2026-10-10.json').write_text(json.dumps(public,indent=2))
    print(json.dumps(budget,indent=2))

if __name__=='__main__':main()
