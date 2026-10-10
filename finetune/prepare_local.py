"""Download public inference artifacts and stage the verified private adapter locally.

No training, cloud compute, or uploads. All downloads live under ignored .data.
"""
import hashlib
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import shutil
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".data/local-model"
ADAPTER = ROOT / ".data/finetune/runs/qwen7b-20261010-v2/adapter"
ADAPTER_SHA = "79e4c915891d43417bf08b81cb5a6841f34fa862f5d9d47a018188d64c74f907"
BASE_REV = "c03e6d358207e414f1eca0bb1891e29f1db0e242"
GGUF_REV = "13fb94bfda8c8cf22497dc57b78f391a9acb426a"
BASE_SHA = "509287f78cb4d4cf6b3843734733b914b2c158e43e22a7f4bf5e963800894d3c"
LLAMA_TAG = "b11541"
LLAMA_COMMIT = "f2918cabbffe8abf8e2a90c1c089085fa116c2cf"

def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def download(url, path, expected=None):
    if path.exists():
        if expected and sha(path) != expected:
            raise RuntimeError(f"Existing artifact hash mismatch: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".part")
    print(f"Downloading public artifact: {path.name}", flush=True)
    offset = partial.stat().st_size if partial.exists() else 0
    req = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
    with urllib.request.urlopen(req, timeout=90) as response:
        resumed = offset and response.status == 206
        with partial.open("ab" if resumed else "wb") as f:
            total = offset if resumed else 0
            last = total
            while chunk := response.read(256 * 1024):
                f.write(chunk)
                total += len(chunk)
                if total - last >= 64 * 1024 * 1024:
                    print(f"{path.name}: {total // 1048576} MiB received", flush=True)
                    last = total
    if expected and sha(partial) != expected:
        raise RuntimeError(f"Downloaded artifact hash mismatch: {path}")
    partial.replace(path)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", action="store_true", help="Also download the 4.7 GB public base weights")
    parser.add_argument("--runtime", action="store_true", help="Also prepare the pinned 18 MB Linux CPU runtime")
    args = parser.parse_args()
    if sha(ADAPTER / "adapter_model.safetensors") != ADAPTER_SHA:
        raise RuntimeError("Training checkpoint hash mismatch")
    OUT.mkdir(parents=True, exist_ok=True)
    download(f"https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct/resolve/{BASE_REV}/config.json", OUT / "base-config/config.json")
    config = json.loads((OUT / "base-config/config.json").read_text())
    if config.get("model_type") != "qwen2" or config.get("num_hidden_layers") != 28:
        raise RuntimeError("Unexpected base model architecture")
    tools = OUT / "tools"
    tree = json.load(urllib.request.urlopen(f"https://api.github.com/repos/ggml-org/llama.cpp/git/trees/{LLAMA_COMMIT}?recursive=1", timeout=30))
    if tree.get("truncated"):
        raise RuntimeError("Incomplete converter tree")
    files = [x for x in tree["tree"] if x["type"] == "blob" and (x["path"] in {"convert_lora_to_gguf.py", "convert_hf_to_gguf.py"} or x["path"].startswith(("conversion/", "gguf-py/gguf/")))]
    def source_file(item):
        rel = Path(item["path"])
        if rel.is_absolute() or ".." in rel.parts:
            raise RuntimeError("Invalid converter path")
        path = tools / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        data = path.read_bytes() if path.exists() else urllib.request.urlopen(f"https://raw.githubusercontent.com/ggml-org/llama.cpp/{LLAMA_COMMIT}/{item['path']}", timeout=30).read()
        git_hash = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if git_hash != item["sha"]:
            raise RuntimeError(f"Converter source mismatch: {rel}")
        path.write_bytes(data)
        return {"path": item["path"], "sha256": hashlib.sha256(data).hexdigest()}
    with ThreadPoolExecutor(max_workers=4) as pool:
        converter_files = list(pool.map(source_file, files))
    proof = {
        "adapter_sha256": ADAPTER_SHA,
        "base_model": "Qwen/Qwen2.5-Coder-7B-Instruct",
        "base_revision": BASE_REV,
        "gguf_repository": "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
        "gguf_revision": GGUF_REV,
        "gguf_sha256": BASE_SHA,
        "llama_tag": LLAMA_TAG,
        "llama_commit": LLAMA_COMMIT,
        "converter_files": converter_files,
        "quantization": "Q4_K_M. Separate from the NF4 evaluation quantization.",
    }
    (OUT / "provenance.json").write_text(json.dumps(proof, indent=2))
    print(f"Verified {len(converter_files)} converter files and the source adapter", flush=True)
    if args.runtime:
        archive = OUT / "llama-cpu-linux.tar.gz"
        download(f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/llama-{LLAMA_TAG}-bin-ubuntu-x64.tar.gz", archive, "36ca310be4405acb7ba59b32dbdce32bb9cd7b1ef95358997b7eaed2c6f0188b")
        runtime = OUT / "runtime"
        runtime.mkdir(exist_ok=True)
        with tarfile.open(archive, "r:gz") as t:
            t.extractall(runtime, filter="data")
        print("Verified and extracted the public Linux CPU runtime", flush=True)
    if args.weights:
        download(f"https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF/resolve/{GGUF_REV}/qwen2.5-coder-7b-instruct-q4_k_m.gguf", OUT / "base-q4_k_m.gguf", BASE_SHA)
        print("Public base weights verified", flush=True)

if __name__ == "__main__":
    main()
