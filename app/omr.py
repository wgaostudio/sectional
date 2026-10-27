"""
Legato 2 optical music recognition.

Follows the Legato 2 model card (huggingface.co/guangyangmusic/legato-2) and paper
(arXiv 2607.05769), since the official `legato.pipeline.Legato2` code is not public yet:
  1. a YOLO detector (segmenter.pt) finds each system on every page (confidence 0.7,
     image size 640); each box is stretched to the full page width, the first box on a
     page is extended up to the page top and the last one down to the page bottom;
  2. the transcriber reads the systems in order. The prompt is
        <bos> [ABC of the systems already read, left-truncated to 1024 tokens]
        <bos> <image> <bos>
     and it answers with that system's ABC (voice blocks + a %%score line; only the
     first system carries the tune header);
  3. the per-system outputs are merged voice by voice (see abc_merge.py).
Decoding: greedy, repetition penalty 1.1, at most 2048 tokens in total.
Pages where the detector finds no music (covers, text pages) are skipped.
"""
from __future__ import annotations

import logging
import os
import re
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional

from PIL import Image, ImageOps

log = logging.getLogger("omr")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vendor" / "legato"))  # Legato 2 model code, bundled (MIT)

REPO = os.environ.get("LEGATO_REPO", "guangyangmusic/legato-2")
MAX_LENGTH = 2048          # card default (prompt + generated tokens)
CONTEXT_TOKENS = 1024      # paper: earlier ABC is left-truncated to half the context
MIN_NEW_TOKENS = 1024
REPETITION_PENALTY = 1.1
YOLO_CONF = float(os.environ.get("LEGATO_YOLO_CONF", "0.7"))
YOLO_IMGSZ = 640
MAX_SIDE = 2400            # downscale very large phone photos before detection

Progress = Callable[[str, float], None]


@dataclass
class Result:
    abc: str                      # merged tune
    systems: List[str]            # raw ABC per system, in reading order
    skipped_pages: List[int]      # 1-based page numbers with no music found
    pages: int
    unreadable: List[tuple] = field(default_factory=list)   # (page, line on page) the model couldn't read
    partial: List[tuple] = field(default_factory=list)      # (page, line on page) read only in part
    # every line of music found, in reading order: page (0-based), box, status, index into systems
    units: List[dict] = field(default_factory=list)


class ModelAccessError(RuntimeError):
    pass


def _pick_device():
    import torch
    forced = os.environ.get("LEGATO_DEVICE")
    if forced:
        return forced
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _pick_dtype(device: str):
    import torch
    forced = os.environ.get("LEGATO_DTYPE")
    if forced:
        return getattr(torch, forced)
    if device == "cuda":
        return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    if device == "mps":
        try:
            (torch.ones(4, device="mps", dtype=torch.bfloat16) * 2).sum().item()
            return torch.bfloat16
        except Exception:
            return torch.float16
    return torch.float32


# ----------------------------------------------------------------------------
# ABC helpers
# ----------------------------------------------------------------------------
def clean_abc(text: str) -> str:
    text = text.replace("<|text|>", "text").replace("\r", "")
    return text.strip("\n") + "\n"


def split_header(abc: str):
    """(header, body) of a merged tune: the header runs through K: and the V: definitions."""
    lines = abc.split("\n")
    seen_k = False
    for i, line in enumerate(lines):
        st = line.strip()
        if st.startswith("K:"):
            seen_k = True
            continue
        if seen_k and (re.match(r"^V:\s*\S+\s*$", st) or (st and not re.match(r"^(?:[A-Za-z]:|%%)", st))):
            return "\n".join(lines[:i]) + "\n", "\n".join(lines[i:])
    return abc, ""


# ----------------------------------------------------------------------------
# Image helpers
# ----------------------------------------------------------------------------
def load_pages(paths: List[str]) -> List[Image.Image]:
    try:  # iPhone photos can arrive as HEIC
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except Exception:
        pass
    pages: List[Image.Image] = []
    for p in paths:
        if p.lower().endswith(".pdf"):
            import fitz  # pymupdf
            with fitz.open(p) as doc:
                for page in doc:
                    pix = page.get_pixmap(dpi=200)
                    pages.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
        else:
            img = Image.open(p)
            img = ImageOps.exif_transpose(img).convert("RGB")
            pages.append(img)
    out = []
    for img in pages:
        scale = MAX_SIDE / max(img.size)
        if scale < 1:
            img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
        out.append(img)
    return out


def _merge_rows(boxes):
    """Merge detections that overlap vertically by more than half (duplicate hits on one system)."""
    boxes = sorted(boxes, key=lambda b: (b[1] + b[3]) / 2)
    merged: List[list] = []
    for b in boxes:
        if merged:
            m = merged[-1]
            overlap = min(m[3], b[3]) - max(m[1], b[1])
            if overlap > 0.5 * min(m[3] - m[1], b[3] - b[1]):
                merged[-1] = [min(m[0], b[0]), min(m[1], b[1]), max(m[2], b[2]), max(m[3], b[3])]
                continue
        merged.append(list(b))
    return merged


# ----------------------------------------------------------------------------
# The engine
# ----------------------------------------------------------------------------
@dataclass
class EngineInfo:
    device: str = ""
    dtype: str = ""
    loaded: bool = False
    error: str = ""


class Legato2:
    def __init__(self):
        self.info = EngineInfo()
        self._lock = threading.Lock()
        self.model = None
        self.processor = None
        self.tokenizer = None
        self.segmenter = None

    # -- loading ---------------------------------------------------------------
    def load(self):
        with self._lock:
            if self.info.loaded:
                return
            try:
                self._load()
                self.info.loaded = True
                self.info.error = ""
            except Exception as e:  # surfaced in the UI
                self.info.error = str(e)
                raise

    def _load(self):
        from huggingface_hub import snapshot_download
        from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError
        from transformers import MllamaForConditionalGeneration, PreTrainedTokenizerFast
        from legato.models import LegatoConfig, LegatoImageProcessor, LegatoProcessor

        try:
            local = snapshot_download(REPO)
        except (GatedRepoError, RepositoryNotFoundError) as e:
            raise ModelAccessError(
                "Can't download Legato 2 yet. Open https://huggingface.co/guangyangmusic/legato-2 "
                "while signed in, accept the access conditions, then run setup.command again "
                "(it signs you in to Hugging Face)."
            ) from e

        device = _pick_device()
        dtype = _pick_dtype(device)
        log.info("Loading Legato 2 on %s (%s)", device, dtype)

        class Legato2Model(MllamaForConditionalGeneration):
            # A plain Mllama model: unlike Legato 1, the Legato 2 checkpoint ships its own
            # vision encoder, so nothing is fetched from meta-llama.
            config_class = LegatoConfig

        model, info = Legato2Model.from_pretrained(local, torch_dtype=dtype, output_loading_info=True)
        missing_vision = [k for k in info.get("missing_keys", []) if "vision_model" in k]
        if missing_vision:
            raise RuntimeError(
                f"The Legato 2 checkpoint is missing {len(missing_vision)} vision-encoder weights; "
                "this app expected them to be bundled. Please report this to the app author."
            )
        model.eval().to(device)

        image_processor = LegatoImageProcessor.from_pretrained(local)
        tokenizer = PreTrainedTokenizerFast.from_pretrained(local)
        processor = LegatoProcessor(image_processor=image_processor, tokenizer=tokenizer)

        segmenter = self.segmenter
        seg_path = Path(local) / "segmenter.pt"
        if segmenter is None and seg_path.exists():
            from ultralytics import YOLO
            segmenter = YOLO(str(seg_path))

        self.model, self.processor, self.tokenizer, self.segmenter = model, processor, tokenizer, segmenter
        self.device, self.dtype = device, dtype
        self.info.device, self.info.dtype = device, str(dtype).replace("torch.", "")

    def load_detector(self):
        """Just the line detector (small), for flagging pages without music before reading."""
        if self.segmenter is not None:
            return self.segmenter
        if getattr(self, "_detector_failed", False):
            raise RuntimeError("line detector unavailable")
        from huggingface_hub import hf_hub_download
        from ultralytics import YOLO
        try:
            try:
                path = hf_hub_download(REPO, "segmenter.pt", local_files_only=True)
            except Exception:
                path = hf_hub_download(REPO, "segmenter.pt")
            self.segmenter = YOLO(path)
        except Exception:
            self._detector_failed = True
            raise
        return self.segmenter

    # -- detection ---------------------------------------------------------------
    def find_systems(self, page: Image.Image) -> List[tuple]:
        """Full-width system strips for one page, top to bottom. [] if no music was found."""
        if self.segmenter is None:
            return [(0, 0, page.width, page.height)]
        res = self.segmenter.predict(page, conf=YOLO_CONF, imgsz=YOLO_IMGSZ, verbose=False, device="cpu")
        boxes = res[0].boxes.xyxy.cpu().numpy().tolist() if len(res) else []
        rows = _merge_rows(boxes)
        if not rows:
            return []
        W, H = page.size
        strips = [[0, y0, W, y1] for _, y0, _, y1 in rows]
        strips[0][1] = 0           # first system reaches up to the page top (title, tempo…)
        strips[-1][3] = H          # last one down to the page bottom
        return [tuple(round(v) for v in b) for b in strips]

    # -- transcription -----------------------------------------------------------
    def _prompt(self, image: Image.Image, context_ids: List[int]) -> dict:
        """<bos> previous-ABC <bos> <image>… <bos>  (Legato 2 paper, App. A.1)."""
        import torch
        from transformers.models.mllama.processing_mllama import (
            convert_sparse_cross_attention_mask_to_dense,
            get_cross_attention_token_mask,
        )

        feats = dict(self.processor.image_processor([image], return_tensors="pt"))
        num_tiles = feats.pop("num_tiles")
        n_images = len(num_tiles[0])
        tok = self.tokenizer
        image_id = tok.convert_tokens_to_ids("<|image|>")
        ids = [tok.bos_token_id] + list(context_ids) + [tok.bos_token_id] + [image_id] * n_images + [tok.bos_token_id]
        cam = convert_sparse_cross_attention_mask_to_dense(
            [get_cross_attention_token_mask(ids, image_id)],
            num_tiles=num_tiles,
            max_num_tiles=self.processor.image_processor.max_image_tiles,
            length=len(ids),
        )
        return {
            "input_ids": torch.tensor([ids]),
            "attention_mask": torch.ones((1, len(ids)), dtype=torch.long),
            "cross_attention_mask": torch.tensor(cam),
            **feats,
        }

    def _generate(self, image: Image.Image, context: List[int], beam_size: int = 1,
                  repetition_penalty: float = REPETITION_PENALTY) -> str:
        import torch
        from transformers import GenerationConfig, StoppingCriteria, StoppingCriteriaList

        class StopOnLoop(StoppingCriteria):
            """Stop when the output turns into a loop (the same few tokens over and over)."""
            def __init__(self, start):
                self.start = start

            def __call__(self, input_ids, scores, **kwargs):
                done = []
                for row in input_ids:
                    tail = row[self.start:].tolist()[-72:]
                    looping = False
                    if len(tail) >= 72:
                        for period in range(1, 9):
                            if all(tail[i] == tail[i - period] for i in range(period, len(tail))):
                                looping = True
                                break
                    done.append(looping)
                return torch.tensor(done, device=input_ids.device)

        inputs = {k: v.to(self.device) for k, v in self._prompt(image, context).items()}
        inputs["pixel_values"] = inputs["pixel_values"].to(self.dtype)
        prompt_len = inputs["input_ids"].shape[1]
        gen = GenerationConfig(
            max_new_tokens=max(MIN_NEW_TOKENS, MAX_LENGTH - prompt_len),
            num_beams=beam_size,
            do_sample=False,
            repetition_penalty=repetition_penalty,
            bos_token_id=self.tokenizer.bos_token_id,
            eos_token_id=self.tokenizer.eos_token_id,
            pad_token_id=self.tokenizer.pad_token_id,
        )
        try:
            with torch.inference_mode():
                out = self.model.generate(**inputs, generation_config=gen, use_model_defaults=False,
                                          stopping_criteria=StoppingCriteriaList([StopOnLoop(prompt_len)]))
        except (RuntimeError, NotImplementedError, TypeError) as e:
            if self.device == "cpu":
                raise
            # Apple-GPU kernels occasionally miss an operation; the CPU always works, just slower.
            log.warning("Generation on %s failed (%s); switching to CPU", self.device, e)
            self.device, self.dtype = "cpu", torch.float32
            self.model.to(self.device, dtype=self.dtype)
            self.info.device, self.info.dtype = "cpu", "float32"
            return self._generate(image, context, beam_size, repetition_penalty)
        return self.tokenizer.decode(out[0, prompt_len:], skip_special_tokens=True)

    # Decoding settings to try, in order. The first is the paper's default; the others are
    # from the same paper's search grid and help when the model gets stuck in a loop.
    ATTEMPTS = [(1, 1.1), (1, 1.2), (5, 1.1)]

    def read_system(self, img: Image.Image, context: List[int], first: bool, beam_size: int = 1):
        """Read one system, retrying when the output breaks down.
        Returns (abc or "", status, raw outputs) with status "ok", "partial" or "failed"."""
        from app.abc_merge import problems, salvage

        first_try = (max(beam_size, 1), REPETITION_PENALTY)
        attempts = [first_try] + [a for a in self.ATTEMPTS if a != first_try]
        raws, best, best_kept = [], "", 0
        for beams, rp in attempts:
            raw = clean_abc(self._generate(img, context, beams, rp))
            raws.append(raw)
            if not problems(raw):
                return raw, "ok", raws
            kept_abc, kept = salvage(raw, first)
            if kept > best_kept:
                best, best_kept = kept_abc, kept
        return best, ("partial" if best_kept else "failed"), raws

    def transcribe(self, paths: List[str], progress: Optional[Progress] = None, beam_size: int = 1,
                   reading_dir: Optional[Path] = None) -> Result:
        from app.abc_merge import merge_systems

        progress = progress or (lambda msg, frac: None)
        progress("Loading the music-reading model (first time takes a minute)…", 0.01)
        self.load()
        pages = load_pages(paths)

        progress("Finding the lines of music…", 0.05)
        units: List[Image.Image] = []
        skipped: List[int] = []
        boxes_log = []
        for n, page in enumerate(pages, 1):
            strips = self.find_systems(page)
            if not strips:
                skipped.append(n)
            boxes_log.append({"page": n, "size": page.size, "systems": strips})
            units.extend(page.crop(b) for b in strips)
        if reading_dir:
            import json
            reading_dir.mkdir(parents=True, exist_ok=True)
            (reading_dir / "systems.json").write_text(json.dumps(boxes_log, indent=1))
        if not units:
            raise RuntimeError("Couldn't find any music on these pages. Try a clearer, straighter photo.")

        outputs: List[str] = []
        context: List[int] = []
        unreadable, partial, units_info = [], [], []
        unit_boxes = [list(b) for page in boxes_log for b in page["systems"]]
        where = [(n, k) for n, page in enumerate(boxes_log, 1) for k in range(1, len(page["systems"]) + 1)]
        for i, img in enumerate(units):
            progress(f"Reading line {i + 1} of {len(units)}…", 0.08 + 0.9 * i / len(units))
            abc, status, raws = self.read_system(img, context[-CONTEXT_TOKENS:], first=not outputs,
                                                 beam_size=beam_size)
            unit = {"page": where[i][0] - 1, "box": unit_boxes[i], "status": status, "out": None}
            units_info.append(unit)
            if status == "failed":
                unreadable.append(where[i])
            else:
                if status == "partial":
                    partial.append(where[i])
                unit["out"] = len(outputs)
                outputs.append(abc)
                # only usable music is passed on to the next line
                context += self.tokenizer(abc, add_special_tokens=False)["input_ids"]
            if reading_dir:
                img.save(reading_dir / f"system-{i + 1:02d}.png")
                for a, raw in enumerate(raws, 1):
                    (reading_dir / f"system-{i + 1:02d}-try{a}.abc").write_text(raw)
                (reading_dir / f"system-{i + 1:02d}.abc").write_text(f"% {status}\n" + abc)
        progress("Done", 1.0)
        if not outputs:
            raise RuntimeError("The model couldn't read any of the music on these pages.")
        return Result(abc=merge_systems(outputs), systems=outputs, skipped_pages=skipped, pages=len(pages),
                      unreadable=unreadable, partial=partial, units=units_info)


ENGINE = Legato2()
