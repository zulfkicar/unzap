FROM python:3.13-slim
WORKDIR /benchmark
COPY . .
RUN python -m pip install --no-cache-dir uv && uv sync --frozen --no-dev
ENV PATH="/benchmark/.venv/bin:${PATH}" PYTHONUNBUFFERED=1
ENTRYPOINT ["auto-bench"]
