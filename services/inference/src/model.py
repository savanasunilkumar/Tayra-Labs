from __future__ import annotations

import time
import json
from dataclasses import dataclass
from pathlib import Path

import torch
from transformers import AutoModelForImageTextToText, AutoProcessor


@dataclass(frozen=True)
class ModelOutput:
    text: str
    output_tokens: int
    gpu_execution_ms: int
    peak_vram_bytes: int = 0


class MolmoRuntime:
    """Loads a pinned Molmo checkpoint once per GPU instance."""

    def __init__(self, model_id: str, model_revision: str, model_path: str = "") -> None:
        self.model_id = model_id
        self.model_revision = model_revision
        checkpoint = model_path or model_id
        if model_path:
            manifest = json.loads((Path(model_path) / ".complete.json").read_text())
            if manifest.get("model_id") != model_id or manifest.get("revision") != model_revision:
                raise RuntimeError("Staged checkpoint identity does not match the configured model")
        options = {"local_files_only": True} if model_path else {"revision": model_revision}
        self.processor = AutoProcessor.from_pretrained(
            checkpoint,
            **options,
            trust_remote_code=True,
        )
        self.model = AutoModelForImageTextToText.from_pretrained(
            checkpoint,
            **options,
            trust_remote_code=True,
            dtype="auto",
            device_map="auto",
        )
        self.model.eval()

    def analyze(self, video_path: Path, prompt: str, max_new_tokens: int) -> ModelOutput:
        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "video", "video": str(video_path)},
                ],
            }
        ]
        inputs = self.processor.apply_chat_template(
            messages,
            tokenize=True,
            add_generation_prompt=True,
            return_tensors="pt",
            return_dict=True,
        )
        inputs = {key: value.to(self.model.device) for key, value in inputs.items()}

        if torch.cuda.is_available():
            torch.cuda.synchronize()
        started = time.perf_counter()
        with torch.inference_mode():
            generated_ids = self.model.generate(**inputs, max_new_tokens=max_new_tokens)
        if torch.cuda.is_available():
            torch.cuda.synchronize()
        elapsed_ms = round((time.perf_counter() - started) * 1_000)

        prompt_tokens = inputs["input_ids"].size(1)
        generated_tokens = generated_ids[0, prompt_tokens:]
        text = self.processor.tokenizer.decode(generated_tokens, skip_special_tokens=True)
        return ModelOutput(
            text=text,
            output_tokens=int(generated_tokens.numel()),
            gpu_execution_ms=elapsed_ms,
            peak_vram_bytes=torch.cuda.max_memory_allocated() if torch.cuda.is_available() else 0,
        )
