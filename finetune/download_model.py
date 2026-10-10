import json
from pathlib import Path
import os
from huggingface_hub import snapshot_download

MODEL = "Qwen/Qwen2.5-Coder-0.5B-Instruct"
destination = Path("/models/base")
revision=os.environ.get("MODEL_REVISION", "ea3f2471cf1b1f0db85067f1ef93848e38e88c25")
snapshot_download(
    repo_id=MODEL,
    revision=revision,
    token=False,
    local_dir=destination,
    allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "LICENSE", "README.md"],
)
config = json.loads((destination / "config.json").read_text())
print(json.dumps({"model": MODEL, "path": str(destination), "architecture": config["architectures"]}))
(destination/'download-manifest.json').write_text(json.dumps({'model':MODEL,'revision':revision,'remote_code':False,'format':'safetensors'},indent=2))
