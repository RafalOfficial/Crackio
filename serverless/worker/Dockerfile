# Crackio's RunPod Serverless worker: ComfyUI and PyTorch as on Crackio's RTX 5090 test box (ComfyUI 0.42.1, torch 2.10
# with CUDA 13.0), and a small handler. CUDA 13 because ComfyUI's int8 kernels (comfy-kitchen) link cuBLASLt 13: on an
# older CUDA, the int8 LTX-2.5 and Gemma fall off their fast path. Needs hosts with driver 580+ (the endpoint's CUDA
# filter: 13.0). Models aren't in the image: they live on the endpoint's network volume (/runpod-volume/models), filled
# once by "fetch" jobs.
FROM pytorch/pytorch:2.10.0-cuda13.0-cudnn9-runtime

# This image's Python is the system's (PEP 668): pip may install into it here, in a container of its own.
ENV DEBIAN_FRONTEND=noninteractive PIP_NO_CACHE_DIR=1 PYTHONUNBUFFERED=1 PIP_BREAK_SYSTEM_PACKAGES=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ffmpeg libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

ARG COMFY_VERSION=v0.42.1
# The image's own torch stays: ComfyUI's requirements are installed against it (a plain "torchvision" from PyPI would
# bring another torch, built for another CUDA).
RUN git clone --depth 1 --branch ${COMFY_VERSION} https://github.com/Comfy-Org/ComfyUI /comfyui \
 && python3 -c "import importlib.metadata as m; names = {d.metadata['Name'].lower() for d in m.distributions()}; [print(f'{p}=={m.version(p)}') for p in ('torch', 'torchvision', 'torchaudio') if p in names]" > /tmp/torch.txt \
 && cat /tmp/torch.txt \
 && python3 -m pip install -c /tmp/torch.txt -r /comfyui/requirements.txt \
 && python3 -m pip install -c /tmp/torch.txt runpod websocket-client requests \
 && python3 -c "import torch; print('torch', torch.__version__, 'cuda', torch.version.cuda)"

COPY extra_model_paths.yaml /extra_model_paths.yaml
COPY handler.py /handler.py

CMD ["python3", "-u", "/handler.py"]
