"""Optional, separately reserved evaluation within the original $15 budget."""
import hashlib
import json
import time
from pathlib import Path

import modal
from finetune.modal_train import image, volume, RUN, VOLUME_NAME

ROOT=Path(__file__).resolve().parents[1]
app=modal.App('unzap-qwen7b-evaluation-budget15',include_source=False)
eval_image=image.add_local_file(ROOT/'finetune/gpu_evaluate.py','/opt/experiment/gpu_evaluate.py',copy=True)

@app.function(image=eval_image,gpu='L40S',cpu=(2,4),memory=(16384,32768),volumes={'/artifacts':volume},timeout=5400,startup_timeout=900,retries=0,max_containers=1,min_containers=0,scaledown_window=2,single_use_containers=True,include_source=False,serialized=True)
def evaluate(payload):
    import sys
    sys.path.insert(0,'/opt/experiment')
    from gpu_evaluate import complete
    return complete(payload,'/artifacts/'+RUN,volume.commit)

@app.local_entrypoint()
def main():
    run=ROOT/'.data/finetune/runs'/RUN
    report=json.loads((run/'report.json').read_text())
    if report['status']!='trained':raise RuntimeError('Training must finish before continuation')
    adapter=run/'adapter/adapter_model.safetensors'
    if not adapter.exists() or hashlib.sha256(adapter.read_bytes()).hexdigest()!=report['adapter_sha256']:
        raise RuntimeError('Download and verify the existing checkpoint first')
    reservation=run/'evaluation-reservation.json'
    if reservation.exists():raise RuntimeError('Evaluation already reserved. Inspect outcome before any further compute.')
    payload=json.loads((run/'cloud-payload.json').read_text())
    payload={'test':payload['test'],'deadline_unix':time.time()+5400}
    ceiling=(5400+900)*(0.000542+4*0.0000131+32*0.00000222)
    reservation.write_text(json.dumps({'started_unix':time.time(),'absolute_deadline_unix':payload['deadline_unix'],'app_id':app.app_id,'additional_resource_ceiling_usd':round(ceiling,2),'total_main_plus_continuation_resource_ceiling_usd':round(9.584+ceiling,2),'remaining_guard_for_setup_cancelled_initialization_network_storage_usd':round(15-9.584-ceiling,2),'volume':VOLUME_NAME,'purpose':'Complete missing pairs only, never repeat training or completed responses.'},indent=2))
    result=evaluate.remote(payload)
    (run/'evaluation-continuation-result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result))
