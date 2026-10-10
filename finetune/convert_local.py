"""Convert the saved adapter to F16 GGUF, without merging or changing the checkpoint."""
import json
import subprocess
import sys
from prepare_local import ROOT, OUT, ADAPTER, ADAPTER_SHA, sha

if sha(ADAPTER / "adapter_model.safetensors") != ADAPTER_SHA:
    raise RuntimeError("Training checkpoint hash mismatch")
target = OUT / "adapter-f16.gguf"
proof_path = OUT / "adapter-conversion.json"
if target.exists():
    proof = json.loads(proof_path.read_text())
    if proof["sha256"] != sha(target) or proof["source_sha256"] != ADAPTER_SHA:
        raise RuntimeError("Existing GGUF adapter provenance mismatch")
    print("Existing verified adapter retained")
else:
    subprocess.run([
        sys.executable, str(OUT / "tools/convert_lora_to_gguf.py"),
        "--base", str(OUT / "base-config"), "--outtype", "f16",
        "--outfile", str(target), str(ADAPTER),
    ], check=True, cwd=ROOT)
    if target.read_bytes()[:4] != b"GGUF":
        raise RuntimeError("Converter did not produce a GGUF adapter")
    proof_path.write_text(json.dumps({"source_sha256": ADAPTER_SHA, "sha256": sha(target), "bytes": target.stat().st_size, "dtype": "f16", "converter_tag": "b11541"}, indent=2))
    print(proof_path.read_text())
