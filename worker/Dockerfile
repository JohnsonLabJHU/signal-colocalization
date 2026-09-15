# Colocalization analysis worker — GPU image for Azure Container Apps (general-gpu profile).
# Build context = the pipelines/ folder:  az acr build -f worker/Dockerfile .
# (so it can COPY both SignalColocalization-main/ and worker/)

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/opt/hf-cache \
    RUNNER_DIR=/opt/SignalColocalization \
    PYTHONPATH=/opt/worker \
    PYTHONHTTPSVERIFY=0

# Python 3.12 + git (dinov3 installs from GitHub; worker reads the git commit for provenance)
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common git curl ca-certificates && \
    add-apt-repository -y ppa:deadsnakes/ppa && apt-get update && \
    apt-get install -y --no-install-recommends python3.12 python3.12-venv python3.12-dev && \
    curl -sS https://bootstrap.pypa.io/get-pip.py | python3.12 && \
    ln -sf /usr/bin/python3.12 /usr/local/bin/python && \
    rm -rf /var/lib/apt/lists/*

# CUDA-enabled PyTorch first so Cellpose picks up the GPU build (CUDA 12.4 wheels)
RUN python -m pip install --upgrade pip && \
    python -m pip install torch --index-url https://download.pytorch.org/whl/cu124

# The pipeline (installs Cellpose, dinov3, bioio readers, etc. from its requirements)
COPY SignalColocalization-main/ /opt/SignalColocalization/
RUN cd /opt/SignalColocalization && \
    python -m pip install --editable . && \
    python -m pip install "openpyxl>=3.1"

# Pre-bake the fine-tuned retinal Cellpose models (~1.16 GB each) so runs never need Hugging Face at run time
RUN cd /opt/SignalColocalization && \
    python -m colocalize --model cpdino_BRN3A --download-models && \
    python -m colocalize --model cpdino_RPBMS --download-models

# Our write-back worker (polls the Analysis-runs store, runs the pipeline, uploads results back)
COPY worker/elab_analysis_worker.py /opt/worker/elab_analysis_worker.py
# sitecustomize.py is auto-imported at interpreter startup for every process that has
# /opt/worker on PYTHONPATH (set above) — including Morgan's runner child — so it disables
# self-signed-cert verification reliably where PYTHONHTTPSVERIFY alone did not.
COPY worker/sitecustomize.py /opt/worker/sitecustomize.py

# Container Apps runs the container as a NON-ROOT user, and files copied in can carry owner-only (600)
# perms — which caused "[Errno 13] Permission denied" opening the worker. Make our code + the model
# cache world-readable / dirs traversable so any runtime user can read them.
RUN chmod -R a+rX /opt/SignalColocalization /opt/worker /opt/hf-cache

WORKDIR /opt/SignalColocalization
ENTRYPOINT ["python", "/opt/worker/elab_analysis_worker.py"]
