FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 HF_HUB_DISABLE_TELEMETRY=1 TOKENIZERS_PARALLELISM=false HF_HOME=/models/huggingface
RUN pip install --no-cache-dir torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir transformers==4.57.6 peft==0.18.1 safetensors==0.7.0
WORKDIR /experiment
COPY finetune/*.py ./
CMD ["python", "train.py", "--help"]
