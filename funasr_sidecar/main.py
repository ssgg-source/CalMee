#!/usr/bin/env python3
"""CalMee FunASR sidecar.

The process speaks newline-delimited JSON on stdin/stdout. All third-party logs
are redirected to stderr so Rust always receives a clean protocol stream.
"""

from __future__ import annotations

import argparse
import contextlib
import difflib
import gc
import json
import os
import platform
import re
import sys
import threading
import time
import traceback
from dataclasses import dataclass
from typing import Any, Callable

os.environ.setdefault("MODELSCOPE_LOG_LEVEL", "30")
os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


@dataclass
class LoadedModel:
    model: Any
    fingerprint: str
    device: str
    model_id: str
    model_path: str | None


@dataclass
class LoadedDiarizer:
    model: Any
    device: str
    model_id: str


_loaded: LoadedModel | None = None
_stream_punctuator: Any = None
_diarizer: LoadedDiarizer | None = None
_stream_cache: dict[str, Any] = {}
_latest_speaker_timeline: list[list[float | int]] = []
_latest_speaker_windows: list[list[float]] = []
_latest_speaker_embeddings: Any = None
_recluster_caches: dict[str, dict[str, Any]] = {}
_protocol_lock = threading.Lock()

_PUNCTUATION = set("，。！？；：、,.!?;:…—-（）()【】[]《》<>“”‘’\"' \\t\\r\\n")
_BACKCHANNELS = {
    "嗯", "嗯嗯", "哦", "啊", "对", "是", "好", "好的", "行", "可以", "没错",
}
_LEXICAL_TOKEN_RE = re.compile(
    r"[A-Za-z]+(?:[-'][A-Za-z]+)*|\d+(?:[.:/-]\d+)*|[\u3400-\u9fff]|"
    r"[^\s，。！？；：、,.!?;:…—–（）()【】\[\]《》<>“”‘’\"']"
)


def _log(message: str) -> None:
    print(f"[calmee-funasr] {message}", file=sys.stderr, flush=True)


def _protocol_write(payload: dict[str, Any]) -> None:
    with _protocol_lock:
        print(json.dumps(payload, ensure_ascii=False), file=sys.__stdout__, flush=True)


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if hasattr(value, "tolist"):
        return _json_safe(value.tolist())
    return str(value)


def _resolve_device(requested: str) -> str:
    import torch

    requested = (requested or "auto").lower()
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda:0"
    if platform.system() == "Darwin" and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _load_fingerprint(config: dict[str, Any]) -> str:
    keys = (
        "model",
        "model_revision",
        "hub",
        "device",
        "ncpu",
        "trust_remote_code",
        "vad_enabled",
        "vad_model",
        "vad_model_revision",
        "vad_max_segment_ms",
        "punc_enabled",
        "punc_model",
        "punc_model_revision",
        "speaker_enabled",
        "speaker_model",
        "speaker_model_revision",
        "speaker_mode",
    )
    return json.dumps({key: config.get(key) for key in keys}, sort_keys=True)


def _unload_model() -> None:
    global _loaded, _stream_cache, _stream_punctuator
    if _loaded is None:
        return
    _log(f"unloading {_loaded.model_id}")
    _loaded = None
    _stream_cache = {}
    _stream_punctuator = None
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        if hasattr(torch, "mps") and hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
    except Exception:
        pass


def _load_model(config: dict[str, Any]) -> LoadedModel:
    global _loaded
    fingerprint = _load_fingerprint(config)
    if _loaded is not None and _loaded.fingerprint == fingerprint:
        return _loaded

    _unload_model()
    device = _resolve_device(str(config.get("device", "auto")))
    model_id = str(config.get("model") or "paraformer-zh")
    kwargs: dict[str, Any] = {
        "model": model_id,
        "hub": config.get("hub", "ms"),
        "device": device,
        "ncpu": int(config.get("ncpu", 4)),
        "disable_update": True,
        "disable_pbar": True,
        "log_level": "ERROR",
    }
    optional = {
        "model_revision": config.get("model_revision"),
        "vad_model_revision": config.get("vad_model_revision"),
        "punc_model_revision": config.get("punc_model_revision"),
        "spk_model_revision": config.get("speaker_model_revision"),
    }
    kwargs.update({key: value for key, value in optional.items() if value})
    if config.get("trust_remote_code"):
        kwargs["trust_remote_code"] = True
    if config.get("vad_enabled", True):
        kwargs["vad_model"] = config.get("vad_model") or "fsmn-vad"
        kwargs["vad_kwargs"] = {
            "max_single_segment_time": int(config.get("vad_max_segment_ms", 60000))
        }
    if config.get("punc_enabled", True):
        kwargs["punc_model"] = config.get("punc_model") or "ct-punc"
    if config.get("speaker_enabled", True):
        kwargs["spk_model"] = config.get("speaker_model") or "cam++"
        kwargs["spk_mode"] = config.get("speaker_mode") or "punc_segment"

    _log(f"loading {model_id} on {device}")
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        from funasr import AutoModel

        # FunASR 1.4.x computes CAM++ cluster centres internally but some
        # package builds do not expose the optional return value consistently.
        # Add the small compatibility wrapper before AutoModel is instantiated.
        import funasr.auto.auto_model as auto_model_module
        if not getattr(auto_model_module.postprocess, "_calmee_centers", False):
            original_postprocess = auto_model_module.postprocess

            def postprocess_with_centers(segments, vad_segments, labels, embeddings, return_spk_center=False):
                global _latest_speaker_timeline, _latest_speaker_windows, _latest_speaker_embeddings
                result = original_postprocess(segments, vad_segments, labels, embeddings)
                # Keep FunASR's smoothed, frame-derived speaker turns.  The
                # stock punc_segment path later collapses every punctuation
                # sentence to one speaker, which can move the last few words of
                # a turn to the next person.  CalMee aligns words to this
                # timeline after recognition instead.
                _latest_speaker_timeline = [
                    [float(item[0]), float(item[1]), int(item[2])]
                    for item in result
                ]
                _latest_speaker_windows = [
                    [float(item[0]), float(item[1])] for item in segments
                ]
                import numpy as np
                _latest_speaker_embeddings = np.asarray(embeddings, dtype="float32").copy()
                if not return_spk_center:
                    return result

                # Reuse the function from the already-loaded postprocess
                # module. Re-importing speaker_utils breaks in some FunASR
                # 1.4.1 wheels because an optional modelscope_file shim is
                # absent even though postprocess itself is available.
                correct_labels = original_postprocess.__globals__["correct_labels"]
                corrected = correct_labels(labels)
                centers = []
                for speaker_index in range(int(corrected.max()) + 1):
                    centers.append(embeddings[corrected == speaker_index].mean(0))
                return result, np.stack(centers)

            postprocess_with_centers._calmee_centers = True
            postprocess_with_centers._calmee_original = original_postprocess
            auto_model_module.postprocess = postprocess_with_centers

        model = AutoModel(**kwargs)
    resolved_path = getattr(model, "model_path", None)
    _loaded = LoadedModel(
        model=model,
        fingerprint=fingerprint,
        device=device,
        model_id=model_id,
        model_path=str(resolved_path) if resolved_path else None,
    )
    _log(f"loaded {model_id} in {time.perf_counter() - started:.1f}s")
    return _loaded


def _download_model(config: dict[str, Any]) -> dict[str, Any]:
    """Download the selected model and its enabled shared helpers without loading them."""
    model_id = str(config.get("model") or "paraformer-zh")
    hub = str(config.get("hub") or "ms")
    requests: list[tuple[str, str, str | None]] = [
        (model_id, hub, config.get("model_revision")),
    ]
    if hub in {"ms", "modelscope"}:
        if config.get("vad_enabled", True):
            requests.append((
                str(config.get("vad_model") or "fsmn-vad"),
                hub,
                config.get("vad_model_revision"),
            ))
        if config.get("punc_enabled", True):
            requests.append((
                str(config.get("punc_model") or "ct-punc"),
                hub,
                config.get("punc_model_revision"),
            ))
        if config.get("speaker_enabled", True):
            requests.append((
                str(config.get("speaker_model") or "cam++"),
                hub,
                config.get("speaker_model_revision"),
            ))

    paths: list[str] = []
    with contextlib.redirect_stdout(sys.stderr):
        from funasr.download.download_model_from_hub import download_model

        for requested_model, requested_hub, revision in requests:
            kwargs: dict[str, Any] = {
                "model": requested_model,
                "hub": requested_hub,
                "check_latest": False,
                "trust_remote_code": bool(config.get("trust_remote_code", False)),
            }
            if revision:
                kwargs["model_revision"] = revision
            _log(f"downloading {requested_model} from {requested_hub}")
            resolved = download_model(**kwargs)
            model_path = str(resolved.get("model_path") or "")
            if not model_path or not os.path.isdir(model_path):
                raise RuntimeError(f"Model download did not produce a usable directory: {requested_model}")
            paths.append(model_path)

    return {"model": model_id, "model_path": paths[0], "model_paths": paths}


def _stream_start(config: dict[str, Any]) -> dict[str, Any]:
    """Load FunASR's native online Paraformer and reset its session cache."""
    global _stream_cache, _stream_punctuator
    online_config = dict(config)
    online_config.update({
        "model": "iic/speech_paraformer_asr_nat-zh-cn-16k-common-vocab8404-online",
        "vad_enabled": False,
        "punc_enabled": False,
        "speaker_enabled": False,
    })
    loaded = _load_model(online_config)
    _stream_cache = {}
    if config.get("punc_enabled", True) and _stream_punctuator is None:
        cache_root = os.environ.get("MODELSCOPE_CACHE", "")
        punc_snapshot = os.path.join(
            cache_root,
            "models",
            "iic--punc_ct-transformer_cn-en-common-vocab471067-large",
            "snapshots",
            "master",
        )
        if os.path.isfile(os.path.join(punc_snapshot, "config.yaml")):
            with contextlib.redirect_stdout(sys.stderr):
                from funasr import AutoModel

                _log("loading local punctuation model for finalized live captions")
                _stream_punctuator = AutoModel(
                    model=punc_snapshot,
                    device=loaded.device,
                    ncpu=int(config.get("ncpu", 4)),
                    disable_update=True,
                    disable_pbar=True,
                    log_level="ERROR",
                )
        else:
            _log("local punctuation model is not installed; live captions will remain unpunctuated")
    elif not config.get("punc_enabled", True):
        _stream_punctuator = None
    return {"loaded": True, "model": loaded.model_id, "device": loaded.device}


def _punctuate_stream_text(text: str) -> dict[str, Any]:
    """Punctuate only a stable endpoint; partial captions remain append-only."""
    cleaned = _clean_transcript_text(text)
    if not cleaned or _stream_punctuator is None:
        return {"text": cleaned}
    with contextlib.redirect_stdout(sys.stderr):
        result = _stream_punctuator.generate(input=cleaned, disable_pbar=True)
    punctuated = str(result[0].get("text") or cleaned) if result else cleaned
    return {"text": _clean_transcript_text(punctuated)}


def _stream_chunk(samples: list[float], is_final: bool = False) -> dict[str, Any]:
    global _stream_cache
    if _loaded is None:
        raise RuntimeError("streaming model is not loaded")
    import numpy as np

    speech = np.asarray(samples or [], dtype="float32")
    if speech.size == 0:
        # An empty decoder flush can hallucinate a short filler token on the
        # online Paraformer checkpoint. The recorded audio is authoritative and
        # will be fully transcribed later, so never invent a live tail token.
        return {"text": "", "is_final": bool(is_final), "elapsed_ms": 0}
    started = time.perf_counter()
    with contextlib.redirect_stdout(sys.stderr):
        raw_result = _loaded.model.generate(
            input=speech,
            cache=_stream_cache,
            is_final=bool(is_final),
            chunk_size=[0, 10, 5],
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
            disable_pbar=True,
        )
    item = raw_result[0] if raw_result else {}
    return {
        "text": _clean_transcript_text(str(item.get("text") or "")),
        "is_final": bool(is_final),
        "elapsed_ms": round((time.perf_counter() - started) * 1000),
    }


def _clean_transcript_text(text: str) -> str:
    # Some multilingual checkpoints occasionally expose decoder control
    # prompts as visible text. They are metadata, never spoken content.
    text = re.sub(r"^\s*(?:<\|[^|>]+\|>\s*)+", "", text)
    text = re.sub(
        r"^\s*(?:ZH\s+)?(?:neutral|natural)\s+speech\s+(?:(?:with|without)\s+itn|within|woitn)[\s,.:;，。；：\-]*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"[，,]+\s*([。！？!?])", r"\1", text)
    text = re.sub(r"([。！？!?，,；;：:、])\1+", r"\1", text)
    text = re.sub(r"\s+([，。！？；：、,.!?;:])", r"\1", text)
    text = re.sub(r"([，。！？；：、])\s+", r"\1", text)
    return text.strip()


def _join_transcript_text(left: str, right: str) -> str:
    left = _clean_transcript_text(left)
    right = _clean_transcript_text(right)
    if not left:
        return right
    if not right:
        return left
    if left[-1] in _PUNCTUATION and right[0] in _PUNCTUATION:
        right = right[1:].lstrip()
    separator = " " if left[-1].isascii() and left[-1].isalnum() and right[:1].isascii() and right[:1].isalnum() else ""
    return _clean_transcript_text(f"{left}{separator}{right}")


def _lexical_text(text: str) -> str:
    return "".join(char for char in text if char not in _PUNCTUATION)


def _word_crosses_boundary(left: str, right: str) -> bool:
    """Return true when punctuation split one Chinese word across two units."""
    left_lexical = _lexical_text(left)[-8:]
    right_lexical = _lexical_text(right)[:8]
    if not left_lexical or not right_lexical:
        return False
    combined = f"{left_lexical}{right_lexical}"
    boundary = len(left_lexical)
    try:
        import jieba

        return any(start < boundary < end for _, start, end in jieba.tokenize(combined))
    except Exception:
        return False


def _join_paragraph_unit(left: str, right: str, gap_ms: int) -> str:
    """Reassemble timestamped units without changing the ASR text.

    Speaker organization is metadata-only. Punctuation repair and wording
    belong to the separate AI-optimized version, so this stage must never add,
    remove, or normalize recognized characters.
    """
    del gap_ms
    return f"{left}{right}"


def _speaker_for_interval(
    start_ms: int,
    end_ms: int,
    timeline: list[list[float | int]],
    fallback: int | None,
) -> int | None:
    if not timeline:
        return fallback
    start = start_ms / 1000.0
    end = max(end_ms, start_ms + 1) / 1000.0
    overlap_by_speaker: dict[int, float] = {}
    for turn_start, turn_end, raw_speaker in timeline:
        overlap = max(0.0, min(end, float(turn_end)) - max(start, float(turn_start)))
        if overlap > 0:
            speaker = int(raw_speaker)
            overlap_by_speaker[speaker] = overlap_by_speaker.get(speaker, 0.0) + overlap
    if overlap_by_speaker:
        return max(overlap_by_speaker, key=overlap_by_speaker.get)
    midpoint = (start + end) / 2.0
    nearest = min(timeline, key=lambda turn: abs(((float(turn[0]) + float(turn[1])) / 2.0) - midpoint))
    return int(nearest[2])


def _sentence_word_units(
    sentence: dict[str, Any], timeline: list[list[float | int]]
) -> list[dict[str, Any]]:
    text = str(sentence.get("text") or sentence.get("sentence") or "").strip()
    if not text:
        return []
    fallback = sentence.get("spk")
    fallback = int(fallback) if fallback is not None else None
    raw_timestamps = sentence.get("timestamp") or []
    timestamps = [
        [int(value[0]), int(value[1])]
        for value in raw_timestamps
        if isinstance(value, (list, tuple)) and len(value) >= 2
    ]
    lexical_positions = [
        index for index, char in enumerate(text)
        if char not in _PUNCTUATION
    ]
    # Paraformer Chinese supplies one timestamp per lexical character.  For a
    # model whose tokenization cannot be mapped losslessly, keep the sentence
    # intact rather than inventing word boundaries.
    if not timestamps or len(timestamps) != len(lexical_positions):
        start_ms = int(sentence.get("start") or (timestamps[0][0] if timestamps else 0))
        end_ms = int(sentence.get("end") or (timestamps[-1][1] if timestamps else start_ms))
        return [{
            "text": text,
            "start_ms": start_ms,
            "end_ms": end_ms,
            "speaker": _speaker_for_interval(start_ms, end_ms, timeline, fallback),
            "timestamp": timestamps,
        }]

    timestamp_by_position = dict(zip(lexical_positions, timestamps))
    try:
        import jieba
        tokens = list(jieba.tokenize(text, mode="default"))
    except Exception:
        tokens = [(char, index, index + 1) for index, char in enumerate(text)]

    units: list[dict[str, Any]] = []
    pending_prefix = ""
    for token, start_pos, end_pos in tokens:
        token_times = [
            timestamp_by_position[index]
            for index in range(start_pos, end_pos)
            if index in timestamp_by_position
        ]
        if not token_times:
            if units:
                units[-1]["text"] += token
            else:
                pending_prefix += token
            continue
        start_ms = min(value[0] for value in token_times)
        end_ms = max(value[1] for value in token_times)
        units.append({
            "text": f"{pending_prefix}{token}",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "speaker": _speaker_for_interval(start_ms, end_ms, timeline, fallback),
            "timestamp": token_times,
        })
        pending_prefix = ""
    if pending_prefix and units:
        units[-1]["text"] += pending_prefix
    return units


def _timed_text_units(
    text: str,
    raw_timestamps: list[Any],
    timeline: list[list[float | int]],
    fallback: int | None = None,
) -> list[dict[str, Any]]:
    """Map FunASR's canonical punctuated text to timestamped word units.

    Paraformer timestamps correspond to Chinese characters, but contiguous
    Latin words and formatted numbers each occupy one timestamp.  Counting raw
    string characters therefore fails on code-switching speech.  Token spans
    preserve this distinction while still allowing Jieba to keep Chinese words
    intact at speaker boundaries.
    """
    text = str(text).strip()
    timestamps = [
        [int(value[0]), int(value[1])]
        for value in raw_timestamps
        if isinstance(value, (list, tuple)) and len(value) >= 2
    ]
    matches = list(_LEXICAL_TOKEN_RE.finditer(text))
    if not text or not timestamps or len(matches) != len(timestamps):
        return []

    return _word_units_from_token_timestamps(text, matches, timestamps, timeline, fallback)


def _word_units_from_token_timestamps(
    text: str,
    matches: list[re.Match[str]],
    timestamps: list[list[int]],
    timeline: list[list[float | int]],
    fallback: int | None = None,
) -> list[dict[str, Any]]:
    timestamp_by_position: dict[int, list[int]] = {}
    for match, timestamp in zip(matches, timestamps):
        for position in range(match.start(), match.end()):
            timestamp_by_position[position] = timestamp

    try:
        import jieba

        tokens = list(jieba.tokenize(text, mode="default"))
    except Exception:
        tokens = [(match.group(0), match.start(), match.end()) for match in matches]

    units: list[dict[str, Any]] = []
    pending_prefix = ""
    for token, start_pos, end_pos in tokens:
        token_times = [
            timestamp_by_position[position]
            for position in range(start_pos, end_pos)
            if position in timestamp_by_position
        ]
        if not token_times:
            if units:
                units[-1]["text"] += token
            else:
                pending_prefix += token
            continue
        # A Latin word maps all its characters to the same ASR timestamp.
        # Deduplicate here so returned timestamp arrays remain compact.
        unique_times: list[list[int]] = []
        for value in token_times:
            if not unique_times or unique_times[-1] != value:
                unique_times.append(value)
        start_ms = min(value[0] for value in unique_times)
        end_ms = max(value[1] for value in unique_times)
        units.append({
            "text": f"{pending_prefix}{token}",
            "start_ms": start_ms,
            "end_ms": end_ms,
            "speaker": _speaker_for_interval(start_ms, end_ms, timeline, fallback),
            "timestamp": unique_times,
        })
        pending_prefix = ""
    if pending_prefix and units:
        units[-1]["text"] += pending_prefix
    return units


def _boundary_quality(units: list[dict[str, Any]], index: int, origin_ms: int) -> float:
    """Score a possible speaker boundary using only pauses and punctuation."""
    if index <= 0 or index >= len(units):
        return float("-inf")
    left, right = units[index - 1], units[index]
    gap_ms = max(0, int(right["start_ms"]) - int(left["end_ms"]))
    left_text = str(left.get("text") or "").rstrip()
    punctuation_score = 0
    if left_text.endswith(tuple("。！？!?；;")):
        punctuation_score = 850
    elif left_text.endswith(tuple("，,：:、")):
        punctuation_score = 280
    distance_penalty = abs(int(right["start_ms"]) - origin_ms) * 0.22
    return min(gap_ms, 1_000) + punctuation_score - distance_penalty


def _snap_speaker_boundaries(units: list[dict[str, Any]]) -> None:
    """Move uncertain CAM++ changes to a nearby word/pause boundary.

    CAM++ windows identify the vicinity of a change, not an exact lexical cut.
    We only move a boundary when a substantially better acoustic pause exists
    within 0.8 seconds and inside the same two speaker runs. ASR punctuation by
    itself is not evidence of a speaker change.
    """
    index = 1
    while index < len(units):
        previous_speaker = units[index - 1].get("speaker")
        current_speaker = units[index].get("speaker")
        if previous_speaker is None or current_speaker is None or previous_speaker == current_speaker:
            index += 1
            continue

        previous_start = index - 1
        while previous_start > 0 and units[previous_start - 1].get("speaker") == previous_speaker:
            previous_start -= 1
        current_end = index + 1
        while current_end < len(units) and units[current_end].get("speaker") == current_speaker:
            current_end += 1

        origin_ms = int(units[index]["start_ms"])
        current_score = _boundary_quality(units, index, origin_ms)
        origin_cuts_word = _word_crosses_boundary(
            str(units[index - 1].get("text") or ""),
            str(units[index].get("text") or ""),
        )
        candidates = [
            candidate
            for candidate in range(max(1, previous_start + 1), min(len(units), current_end))
            if abs(int(units[candidate]["start_ms"]) - origin_ms) <= 800
            and (
                max(0, int(units[candidate]["start_ms"]) - int(units[candidate - 1]["end_ms"]))
                >= 180
                or origin_cuts_word
            )
        ]
        best = max(candidates, key=lambda candidate: _boundary_quality(units, candidate, origin_ms), default=index)
        best_score = _boundary_quality(units, best, origin_ms)
        if best != index and best_score >= current_score + 320:
            if best > index:
                for unit in units[index:best]:
                    unit["speaker"] = previous_speaker
            else:
                for unit in units[best:index]:
                    unit["speaker"] = current_speaker
            index = max(1, best)
        else:
            index = current_end


def _timed_text_units_from_sentences(
    text: str,
    sentence_info: list[dict[str, Any]],
    timeline: list[list[float | int]],
) -> list[dict[str, Any]]:
    """Recover canonical-text timing when ITN changes the global token count.

    Long meetings commonly contain model names, abbreviations, dates and
    numbers.  FunASR's canonical text may combine those tokens after timestamp
    generation, so a strict count check can fail and previously forced CalMee
    back to the fragmented punctuation-sentence list.  Aligning the per-sentence
    timestamp tokens to the canonical token sequence keeps the clean text while
    retaining the original acoustic timing.
    """
    text = str(text).strip()
    canonical_matches = list(_LEXICAL_TOKEN_RE.finditer(text))
    if not text or not canonical_matches:
        return []

    source_tokens: list[str] = []
    source_timestamps: list[list[int]] = []
    for sentence in sentence_info:
        if not isinstance(sentence, dict):
            continue
        sentence_text = str(sentence.get("text") or sentence.get("sentence") or "").strip()
        sentence_matches = list(_LEXICAL_TOKEN_RE.finditer(sentence_text))
        sentence_timestamps = [
            [int(value[0]), int(value[1])]
            for value in sentence.get("timestamp") or []
            if isinstance(value, (list, tuple)) and len(value) >= 2
        ]
        if not sentence_matches or len(sentence_matches) != len(sentence_timestamps):
            continue
        source_tokens.extend(match.group(0).casefold() for match in sentence_matches)
        source_timestamps.extend(sentence_timestamps)
    if not source_tokens:
        return []

    canonical_tokens = [match.group(0).casefold() for match in canonical_matches]
    aligned: list[list[int] | None] = [None] * len(canonical_tokens)
    matcher = difflib.SequenceMatcher(
        None, source_tokens, canonical_tokens, autojunk=False
    )
    for tag, source_start, source_end, target_start, target_end in matcher.get_opcodes():
        source_length = source_end - source_start
        target_length = target_end - target_start
        if tag == "equal":
            for offset in range(target_length):
                aligned[target_start + offset] = source_timestamps[source_start + offset]
        elif tag == "replace" and source_length > 0 and target_length > 0:
            for offset in range(target_length):
                source_offset = min(
                    source_length - 1,
                    int(offset * source_length / target_length),
                )
                aligned[target_start + offset] = source_timestamps[source_start + source_offset]

    mapped = [index for index, value in enumerate(aligned) if value is not None]
    if len(mapped) < max(1, int(len(aligned) * 0.9)):
        return []
    # ITN-only insertions are rare.  Give them the nearest acoustic token time
    # rather than shifting every timestamp after the first mismatch.
    for index, value in enumerate(aligned):
        if value is not None:
            continue
        nearest = min(mapped, key=lambda candidate: abs(candidate - index))
        aligned[index] = aligned[nearest]
    return _word_units_from_token_timestamps(
        text,
        canonical_matches,
        [value for value in aligned if value is not None],
        timeline,
    )


def _repair_short_speaker_islands(units: list[dict[str, Any]]) -> None:
    # A short A-B-A island is usually boundary jitter. In the organized speaker
    # version, an isolated sub-second backchannel also must not break a long
    # main-speaker paragraph. The immutable raw version remains untouched.
    for _ in range(2):
        changed = False
        for index in range(1, len(units) - 1):
            previous, current, following = units[index - 1], units[index], units[index + 1]
            if previous["speaker"] is None or previous["speaker"] != following["speaker"]:
                continue
            if current["speaker"] == previous["speaker"]:
                continue
            lexical = "".join(char for char in current["text"] if char not in _PUNCTUATION)
            duration = max(0, current["end_ms"] - current["start_ms"])
            previous_gap = max(0, current["start_ms"] - previous["end_ms"])
            following_gap = max(0, following["start_ms"] - current["end_ms"])
            isolated_backchannel = (
                lexical in _BACKCHANNELS
                and duration <= 1_100
                and previous_gap <= 900
                and following_gap <= 900
            )
            if isolated_backchannel or (lexical not in _BACKCHANNELS and (len(lexical) <= 2 or duration <= 450)):
                current["speaker"] = previous["speaker"]
                changed = True
        if not changed:
            break

    # Also repair a short edge island when only one neighbouring run is
    # available.  Require a tiny time gap and never rewrite genuine Chinese
    # backchannels such as “嗯/对”.  This catches repeated jitter (A-B-C-A)
    # that a strict A-B-A pass cannot resolve.
    for index, current in enumerate(units):
        lexical = _lexical_text(current["text"])
        duration = max(0, current["end_ms"] - current["start_ms"])
        if not lexical or lexical in _BACKCHANNELS or (len(lexical) > 2 and duration > 500):
            continue
        candidates: list[tuple[int, int]] = []
        if index > 0 and units[index - 1]["speaker"] is not None:
            gap = max(0, current["start_ms"] - units[index - 1]["end_ms"])
            candidates.append((gap, int(units[index - 1]["speaker"])))
        if index + 1 < len(units) and units[index + 1]["speaker"] is not None:
            gap = max(0, units[index + 1]["start_ms"] - current["end_ms"])
            candidates.append((gap, int(units[index + 1]["speaker"])))
        if candidates:
            gap, speaker = min(candidates, key=lambda value: value[0])
            if gap <= 450:
                current["speaker"] = speaker


def _refine_diarized_sentences(
    sentence_info: list[dict[str, Any]], timeline: list[list[float | int]]
) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    for sentence in sentence_info:
        if isinstance(sentence, dict):
            units.extend(_sentence_word_units(sentence, timeline))
    return _refine_word_units(units)


def _refine_word_units(units: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not units:
        return []
    _repair_short_speaker_islands(units)
    _snap_speaker_boundaries(units)

    paragraphs: list[dict[str, Any]] = []
    for unit in units:
        if not unit["text"].strip():
            continue
        current = paragraphs[-1] if paragraphs else None
        gap_ms = unit["start_ms"] - current["end_ms"] if current else 0
        can_merge = bool(
            current
            and current["speaker"] == unit["speaker"]
            and gap_ms <= 8_000
        )
        if can_merge:
            current["text"] = _join_paragraph_unit(current["text"], unit["text"], gap_ms)
            current["end_ms"] = max(current["end_ms"], unit["end_ms"])
            current["timestamp"].extend(unit["timestamp"])
        else:
            paragraphs.append({
                "text": unit["text"],
                "start_ms": unit["start_ms"],
                "end_ms": unit["end_ms"],
                "speaker": unit["speaker"],
                "timestamp": list(unit["timestamp"]),
            })

    for index, paragraph in enumerate(paragraphs):
        paragraph["index"] = index
    return paragraphs


def _normalize_segments(
    item: dict[str, Any], speaker_timeline: list[list[float | int]] | None = None
) -> list[dict[str, Any]]:
    sentence_info = item.get("sentence_info") or []
    if speaker_timeline:
        canonical_units = _timed_text_units(
            str(item.get("text") or ""),
            item.get("timestamp") or [],
            speaker_timeline,
        )
        refined = _refine_word_units(canonical_units)
        if refined:
            return refined
        aligned_units = _timed_text_units_from_sentences(
            str(item.get("text") or ""),
            sentence_info,
            speaker_timeline,
        )
        refined = _refine_word_units(aligned_units)
        if refined:
            return refined
    if speaker_timeline and sentence_info:
        refined = _refine_diarized_sentences(sentence_info, speaker_timeline)
        if refined:
            return refined
    segments: list[dict[str, Any]] = []
    for index, sentence in enumerate(sentence_info):
        if not isinstance(sentence, dict):
            continue
        speaker = sentence.get("spk")
        segments.append(
            {
                "index": index,
                "text": str(sentence.get("text") or "").strip(),
                "start_ms": int(sentence.get("start") or 0),
                "end_ms": int(sentence.get("end") or 0),
                "speaker": int(speaker) if speaker is not None else None,
                "timestamp": _json_safe(sentence.get("timestamp") or []),
            }
        )
    if not segments and item.get("text"):
        timestamp = item.get("timestamp") or []
        end_ms = 0
        if timestamp and isinstance(timestamp[-1], (list, tuple)) and len(timestamp[-1]) > 1:
            end_ms = int(timestamp[-1][1])
        segments.append(
            {
                "index": 0,
                "text": str(item.get("text") or "").strip(),
                "start_ms": 0,
                "end_ms": end_ms,
                "speaker": None,
                "timestamp": _json_safe(timestamp),
            }
        )
    return segments


def _transcribe(
    config: dict[str, Any],
    audio_path: str,
    progress_callback: Callable[[int, str], None] | None = None,
    cache_key: str | None = None,
) -> dict[str, Any]:
    global _latest_speaker_timeline, _latest_speaker_windows, _latest_speaker_embeddings
    if progress_callback:
        progress_callback(2, "Preparing the FunASR model…")
    loaded = _load_model(config)
    if progress_callback:
        progress_callback(8, f"Model ready on {loaded.device.upper()}. Analyzing audio…")
    hotwords = str(config.get("hotwords") or "").strip()
    native_progress = {
        "calls": 0,
        "value": 8,
        "segments": 0,
        "last_current": 0,
        "last_total": 0,
        "message": "Detecting speech…",
    }
    progress_started = time.perf_counter()
    heartbeat_stop = threading.Event()

    def heartbeat() -> None:
        while not heartbeat_stop.wait(3.0):
            if not progress_callback:
                continue
            elapsed = int(time.perf_counter() - progress_started)
            progress_callback(
                int(native_progress["value"]),
                f'{native_progress["message"]} ({elapsed}s elapsed)',
            )

    heartbeat_thread = threading.Thread(target=heartbeat, name="funasr-progress", daemon=True)
    heartbeat_thread.start()

    def report_native_progress(current: int, total: int) -> None:
        if not progress_callback:
            return
        native_progress["calls"] += 1
        if native_progress["calls"] == 1 and total <= 1:
            value = 20
            message = "Speech detection complete. Preparing recognition…"
        else:
            current = max(int(current), 0)
            total = max(int(total), 1)
            starts_new_batch = (
                total != native_progress["last_total"]
                or current < native_progress["last_current"]
                or native_progress["last_current"] >= native_progress["last_total"]
            )
            delta = current if starts_new_batch else max(current - native_progress["last_current"], 0)
            native_progress["segments"] += delta
            native_progress["last_current"] = current
            native_progress["last_total"] = total
            # FunASR reports progress per internal batch rather than across the
            # whole recording. Advance monotonically without presenting the
            # misleading batch-local current/total pair as a global total.
            value = min(30 + (native_progress["calls"] - 1) * 8, 88)
            message = f'Recognizing speech. Processed about {native_progress["segments"]} speech segments…'
        native_progress["value"] = max(int(native_progress["value"]), value)
        native_progress["message"] = message
        progress_callback(int(native_progress["value"]), message)

    requested_batch_size = int(config.get("batch_size_s", 60))
    # Smaller MPS batches provide regular progress callbacks and reduce peak
    # unified-memory pressure. Existing configs that still say 300 are capped.
    effective_batch_size = min(requested_batch_size, 60) if loaded.device == "mps" else min(requested_batch_size, 120)

    generate_kwargs: dict[str, Any] = {
        "input": audio_path,
        "batch_size_s": max(effective_batch_size, 1),
        "is_final": True,
        "language": config.get("language") or "auto",
        "use_itn": bool(config.get("use_itn", True)),
        "sentence_timestamp": bool(config.get("sentence_timestamp", True)),
        "return_raw_text": bool(config.get("return_raw_text", False)),
        "merge_vad": bool(config.get("merge_vad", True)),
        "merge_length_s": int(config.get("merge_length_s", 15)),
        "return_spk_res": bool(config.get("speaker_enabled", True)),
        "return_spk_center": bool(config.get("speaker_enabled", True)),
        "progress_callback": report_native_progress,
    }
    # Keep automatic speaker-count estimation by default.  For difficult or
    # very short recordings callers may provide an expected count; the same
    # option is also used by the standalone CAM++ path below.
    preset_speaker_count = config.get("preset_speaker_count")
    if preset_speaker_count:
        generate_kwargs["preset_spk_num"] = int(preset_speaker_count)
    if config.get("speaker_enabled", True) and hasattr(loaded.model, "cb_model"):
        loaded.model.cb_model.model_config["merge_thr"] = float(
            config.get("speaker_merge_threshold", 0.78)
        )
    if hotwords:
        generate_kwargs["hotword"] = hotwords
    postprocess_hotwords = str(config.get("postprocess_hotwords") or "").strip()
    if postprocess_hotwords:
        generate_kwargs["postprocess_hotwords"] = postprocess_hotwords
        generate_kwargs["postprocess_hotword_threshold"] = float(
            config.get("postprocess_hotword_threshold", 0.8)
        )
        generate_kwargs["return_postprocess_hotword_matches"] = True

    started = time.perf_counter()
    _latest_speaker_timeline = []
    _latest_speaker_windows = []
    _latest_speaker_embeddings = None
    # FunASR's spectral speaker count is deterministic, but its KMeans labels
    # were initialized randomly.  Seed both libraries so identical audio and
    # settings always produce identical Speaker IDs and boundaries.
    import numpy as np
    import torch

    random_seed = int(config.get("speaker_random_seed", 0))
    np.random.seed(random_seed)
    torch.manual_seed(random_seed)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            raw_result = loaded.model.generate(**generate_kwargs)
    finally:
        heartbeat_stop.set()
        heartbeat_thread.join(timeout=1.0)
    if progress_callback:
        if config.get("speaker_enabled", True):
            progress_callback(95, "Finalizing punctuation, timestamps, and speakers…")
        else:
            progress_callback(95, "Finalizing punctuation and timestamps…")
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    item = raw_result[0] if raw_result else {}
    text = str(item.get("text") or "").strip()
    segments = _normalize_segments(
        item,
        _latest_speaker_timeline if config.get("speaker_enabled", True) else None,
    )
    text = _clean_transcript_text(text)
    for segment in segments:
        segment["text"] = _clean_transcript_text(str(segment.get("text") or ""))
    segments = [segment for segment in segments if segment.get("text")]
    # Speaker IDs exposed by some clustering runs are sparse (for example
    # 0, 2, 4).  Normalize by first appearance so UI labels and voiceprint
    # centres always refer to the same compact sequence.
    speaker_id_map: dict[int, int] = {}
    for segment in segments:
        speaker = segment.get("speaker")
        if speaker is None:
            continue
        speaker = int(speaker)
        if speaker not in speaker_id_map:
            speaker_id_map[speaker] = len(speaker_id_map)
        segment["speaker"] = speaker_id_map[speaker]
    speakers = sorted(
        {segment["speaker"] for segment in segments if segment.get("speaker") is not None}
    )
    speaker_centers = item.get("spk_embedding_center")
    speaker_embeddings: dict[str, Any] = {}
    if speaker_centers is not None:
        safe_centers = _json_safe(speaker_centers)
        if isinstance(safe_centers, list):
            speaker_embeddings = {
                f"Speaker {new_speaker + 1}": safe_centers[old_speaker]
                for old_speaker, new_speaker in speaker_id_map.items()
                if old_speaker < len(safe_centers) and isinstance(safe_centers[old_speaker], list)
            }
    result = {
        "text": text,
        "raw_text": item.get("raw_text"),
        "language": item.get("language") or config.get("language") or "auto",
        "segments": segments,
        "timestamp": _json_safe(item.get("timestamp") or []),
        "speaker_count": len(speakers),
        "speaker_embeddings": speaker_embeddings,
        "hotword_matches": _json_safe(item.get("postprocess_hotword_matches") or []),
        "elapsed_ms": elapsed_ms,
        "device": loaded.device,
        "model": loaded.model_id,
    }
    if (
        cache_key
        and config.get("speaker_enabled", True)
        and _latest_speaker_windows
        and _latest_speaker_embeddings is not None
    ):
        _recluster_caches[cache_key] = {
            "kind": "transcript",
            "item": item,
            "windows": list(_latest_speaker_windows),
            "embeddings": _latest_speaker_embeddings.copy(),
            "config": dict(config),
            "estimated_count": len(speakers),
            "current_count": len(speakers),
            "elapsed_ms": elapsed_ms,
            "device": loaded.device,
            "model": loaded.model_id,
        }
    return result


def _recluster_status(cache_key: str) -> dict[str, Any]:
    cache = _recluster_caches.get(cache_key)
    if not cache:
        return {"available": False, "estimated_count": 0, "current_count": 0}
    return {
        "available": True,
        "estimated_count": int(cache.get("estimated_count") or 0),
        "current_count": int(cache.get("current_count") or 0),
    }


def _recluster_transcript(cache_key: str, speaker_count: int) -> dict[str, Any]:
    cache = _recluster_caches.get(cache_key)
    if not cache:
        raise ValueError("No reusable CAM++ result is available for this meeting")
    if speaker_count < 1 or speaker_count > 20:
        raise ValueError("speaker_count must be between 1 and 20")

    import numpy as np
    import torch
    import funasr.auto.auto_model as auto_model_module

    embeddings = np.asarray(cache["embeddings"], dtype="float32")
    random_seed = int(cache["config"].get("speaker_random_seed", 0))
    np.random.seed(random_seed)
    torch.manual_seed(random_seed)
    if len(embeddings) < 2 or speaker_count == 1:
        labels = np.zeros(len(embeddings), dtype="int")
    elif cache.get("kind") == "external":
        from funasr.models.campplus.cluster_backend import ClusterBackend
        labels = ClusterBackend(
            merge_thr=float(cache["config"].get("speaker_merge_threshold", 0.78))
        )(embeddings, oracle_num=int(speaker_count))
    else:
        loaded = _loaded
        if loaded is None or not hasattr(loaded.model, "cb_model"):
            raise ValueError("The FunASR speaker model is no longer loaded")
        labels = loaded.model.cb_model(
            torch.from_numpy(embeddings).cpu(), oracle_num=int(speaker_count)
        )
    if cache.get("kind") == "external":
        from funasr.models.campplus.utils import correct_labels, postprocess
        timeline = postprocess(cache["windows"], None, labels, embeddings)
        corrected = correct_labels(np.asarray(labels, dtype="int"))
        label_map: dict[int, int] = {}
        normalized_timeline: list[list[float | int]] = []
        for start, end, raw_speaker in timeline:
            raw_speaker = int(raw_speaker)
            if raw_speaker not in label_map:
                label_map[raw_speaker] = len(label_map)
            normalized_timeline.append([float(start), float(end), label_map[raw_speaker]])
        segments: list[dict[str, Any]] = []
        for index, source in enumerate(cache["segments"]):
            speaker = _speaker_for_interval(
                int(source["start_ms"]), int(source["end_ms"]), normalized_timeline, None
            )
            segments.append({
                "index": index,
                "text": str(source.get("text") or "").strip(),
                "start_ms": int(source["start_ms"]),
                "end_ms": int(source["end_ms"]),
                "speaker": speaker,
                "timestamp": [],
            })
        speaker_embeddings = {
            f"Speaker {normalized + 1}": embeddings[corrected == original].mean(axis=0).tolist()
            for original, normalized in label_map.items()
            if np.any(corrected == original)
        }
        actual_count = len(label_map)
        cache["current_count"] = actual_count
        return {
            "text": "",
            "raw_text": None,
            "language": "auto",
            "segments": segments,
            "timestamp": [],
            "speaker_count": actual_count,
            "speaker_embeddings": speaker_embeddings,
            "hotword_matches": [],
            "elapsed_ms": 0,
            "device": cache["device"],
            "model": cache["model"],
        }
    timeline, centers = auto_model_module.postprocess(
        cache["windows"], None, labels, embeddings, return_spk_center=True
    )
    item = cache["item"]
    segments = _normalize_segments(item, timeline)
    speaker_id_map: dict[int, int] = {}
    for segment in segments:
        speaker = segment.get("speaker")
        if speaker is None:
            continue
        speaker = int(speaker)
        if speaker not in speaker_id_map:
            speaker_id_map[speaker] = len(speaker_id_map)
        segment["speaker"] = speaker_id_map[speaker]
    safe_centers = _json_safe(centers)
    speaker_embeddings = {
        f"Speaker {new_speaker + 1}": safe_centers[old_speaker]
        for old_speaker, new_speaker in speaker_id_map.items()
        if old_speaker < len(safe_centers) and isinstance(safe_centers[old_speaker], list)
    }
    actual_count = len(speaker_id_map)
    cache["current_count"] = actual_count
    return {
        "text": str(item.get("text") or "").strip(),
        "raw_text": item.get("raw_text"),
        "language": item.get("language") or cache["config"].get("language") or "auto",
        "segments": segments,
        "timestamp": _json_safe(item.get("timestamp") or []),
        "speaker_count": actual_count,
        "speaker_embeddings": speaker_embeddings,
        "hotword_matches": _json_safe(item.get("postprocess_hotword_matches") or []),
        "elapsed_ms": 0,
        "device": cache["device"],
        "model": cache["model"],
    }


def _load_diarizer(config: dict[str, Any]) -> LoadedDiarizer:
    """Load the shared CAM++ embedding model used after any ASR engine."""
    global _diarizer
    device = _resolve_device(str(config.get("device", "auto")))
    model_id = str(config.get("speaker_model") or "cam++")
    if _diarizer is not None and _diarizer.device == device and _diarizer.model_id == model_id:
        return _diarizer
    model_reference = model_id
    if model_id == "cam++":
        # FunASR's alias resolver checks ModelScope even when the complete
        # snapshot is already cached. Prefer the canonical local snapshot so
        # speaker diarization remains genuinely offline.
        cache_roots = [
            os.environ.get("MODELSCOPE_CACHE"),
            os.path.join(os.path.expanduser("~"), ".cache", "modelscope", "hub"),
        ]
        for cache_root in filter(None, cache_roots):
            candidate = os.path.join(
                str(cache_root), "iic", "speech_campplus_sv_zh-cn_16k-common"
            )
            if os.path.isfile(os.path.join(candidate, "config.yaml")):
                model_reference = candidate
                break
    with contextlib.redirect_stdout(sys.stderr):
        from funasr import AutoModel

        model = AutoModel(
            model=model_reference,
            hub=config.get("speaker_hub", "ms"),
            device=device,
            ncpu=int(config.get("ncpu", 4)),
            disable_update=True,
            disable_pbar=True,
            log_level="ERROR",
        )
    _diarizer = LoadedDiarizer(model=model, device=device, model_id=model_id)
    return _diarizer


def _diarize_segments(
    config: dict[str, Any],
    audio_path: str,
    transcript_segments: list[dict[str, Any]],
    progress_callback: Callable[[int, str], None] | None = None,
    cache_key: str | None = None,
) -> dict[str, Any]:
    """Assign meeting-local Speaker IDs to timestamped ASR segments.

    The text can come from Whisper, Parakeet, Qwen3-ASR, or FunASR. CAM++ only
    sees the audio and timestamps, so this layer remains independent from ASR.
    """
    import math
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    from funasr.models.campplus.cluster_backend import ClusterBackend
    from funasr.models.campplus.utils import correct_labels, postprocess, sv_chunk

    if progress_callback:
        progress_callback(4, "Loading the meeting speaker model…")
    loaded = _load_diarizer(config)
    if progress_callback:
        progress_callback(12, f"Speaker model ready on {loaded.device.upper()}. Decoding audio…")
    audio, sample_rate = sf.read(audio_path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sample_rate != 16000:
        divisor = math.gcd(int(sample_rate), 16000)
        audio = resample_poly(audio, 16000 // divisor, int(sample_rate) // divisor).astype("float32")
    speech_regions: list[list[Any]] = []
    normalized_segments: list[dict[str, Any]] = []
    for segment in transcript_segments:
        start_ms = max(0, int(segment.get("start_ms") or 0))
        end_ms = max(start_ms + 100, int(segment.get("end_ms") or start_ms + 100))
        start_sample = min(len(audio), int(start_ms * 16))
        end_sample = min(len(audio), max(start_sample + 1, int(end_ms * 16)))
        if end_sample <= start_sample:
            continue
        normalized_segments.append({
            "start_ms": start_ms,
            "end_ms": end_ms,
            "text": str(segment.get("text") or "").strip(),
        })
        speech_regions.append([start_ms / 1000.0, end_ms / 1000.0, audio[start_sample:end_sample]])
    if not speech_regions:
        return {"assignments": [], "speaker_embeddings": {}, "speaker_count": 0}

    chunks = sv_chunk(speech_regions)
    chunk_audio = [item[2] for item in chunks]
    if progress_callback:
        progress_callback(28, f"Extracting voiceprints from {len(chunks)} speech windows…")
    with contextlib.redirect_stdout(sys.stderr):
        embedding_results = loaded.model.generate(
            input=chunk_audio,
            batch_size=max(1, min(int(config.get("speaker_batch_size", 16)), 32)),
        )
    embeddings = np.concatenate(
        [_json_safe(item["spk_embedding"]) for item in embedding_results], axis=0
    ).astype("float32")
    if progress_callback:
        progress_callback(72, "Clustering speakers within this meeting…")
    np.random.seed(int(config.get("speaker_random_seed", 0)))
    if len(embeddings) < 2:
        raw_labels = np.zeros(len(embeddings), dtype="int")
    else:
        preset = config.get("preset_speaker_count")
        raw_labels = ClusterBackend(merge_thr=float(config.get("speaker_merge_threshold", 0.78)))(
            embeddings,
            **({"oracle_num": int(preset)} if preset else {}),
        )

    # Convert overlapping CAM++ windows into a smoothed speaker timeline before
    # assigning ASR segments.  This is the same midpoint + short-turn smoothing
    # stage used by FunASR's native meeting pipeline and is materially more
    # stable than voting directly over overlapping raw windows.
    corrected_labels = correct_labels(np.asarray(raw_labels, dtype="int"))
    speaker_turns = postprocess(chunks, None, raw_labels, embeddings)

    # Normalize arbitrary cluster IDs by first chronological appearance.
    label_map: dict[int, int] = {}
    normalized_turns: list[list[float | int]] = []
    for start, end, raw_value in speaker_turns:
        value = int(raw_value)
        if value not in label_map:
            label_map[value] = len(label_map)
        normalized_turns.append([float(start), float(end), label_map[value]])

    assignments: list[int] = []
    for segment in normalized_segments:
        start = segment["start_ms"] / 1000.0
        end = segment["end_ms"] / 1000.0
        overlap_by_speaker: dict[int, float] = {}
        for turn_start, turn_end, label in normalized_turns:
            overlap = max(0.0, min(end, float(turn_end)) - max(start, float(turn_start)))
            if overlap > 0:
                label = int(label)
                overlap_by_speaker[label] = overlap_by_speaker.get(label, 0.0) + overlap
        if overlap_by_speaker:
            assignments.append(max(overlap_by_speaker, key=overlap_by_speaker.get) + 1)
        else:
            midpoint = (start + end) / 2.0
            nearest = min(
                normalized_turns,
                key=lambda turn: abs(((float(turn[0]) + float(turn[1])) / 2.0) - midpoint),
            )
            assignments.append(int(nearest[2]) + 1)

    centers = {
        f"Speaker {normalized + 1}": embeddings[corrected_labels == original].mean(axis=0).tolist()
        for original, normalized in label_map.items()
        if np.any(corrected_labels == original)
    }
    if progress_callback:
        progress_callback(96, "Finalizing Speaker IDs…")
    result = {
        "assignments": assignments,
        "speaker_embeddings": centers,
        "speaker_count": len(label_map),
        "device": loaded.device,
        "model": loaded.model_id,
    }
    if cache_key:
        _recluster_caches[cache_key] = {
            "kind": "external",
            "segments": normalized_segments,
            "windows": [[float(item[0]), float(item[1])] for item in chunks],
            "embeddings": embeddings.copy(),
            "config": dict(config),
            "estimated_count": len(label_map),
            "current_count": len(label_map),
            "device": loaded.device,
            "model": loaded.model_id,
        }
    return result


def _handle(
    request: dict[str, Any],
    progress_callback: Callable[[int, str], None] | None = None,
) -> dict[str, Any]:
    action = request.get("action")
    config = request.get("config") or {}
    if action == "ping":
        return {"ready": True, "loaded": _loaded is not None}
    if action == "status":
        return {
            "ready": True,
            "loaded": _loaded is not None,
            "model": _loaded.model_id if _loaded else None,
            "device": _loaded.device if _loaded else None,
            "model_path": _loaded.model_path if _loaded else None,
        }
    if action == "load":
        loaded = _load_model(config)
        return {
            "loaded": True,
            "model": loaded.model_id,
            "device": loaded.device,
            "model_path": loaded.model_path,
        }
    if action == "download":
        return _download_model(config)
    if action == "stream_start":
        return _stream_start(config)
    if action == "stream_chunk":
        return _stream_chunk(
            request.get("samples") or [],
            bool(request.get("is_final", False)),
        )
    if action == "stream_punctuate":
        return _punctuate_stream_text(str(request.get("text") or ""))
    if action == "unload":
        _unload_model()
        return {"loaded": False}
    if action == "transcribe":
        audio_path = str(request.get("audio_path") or request.get("wav_path") or "")
        if not audio_path or not os.path.isfile(audio_path):
            raise FileNotFoundError(f"audio file not found: {audio_path}")
        return _transcribe(
            config,
            audio_path,
            progress_callback,
            str(request.get("cache_key") or "") or None,
        )
    if action == "recluster_status":
        return _recluster_status(str(request.get("cache_key") or ""))
    if action == "recluster_transcript":
        return _recluster_transcript(
            str(request.get("cache_key") or ""),
            int(request.get("speaker_count") or 0),
        )
    if action == "diarize_segments":
        audio_path = str(request.get("audio_path") or "")
        if not audio_path or not os.path.isfile(audio_path):
            raise FileNotFoundError(f"audio file not found: {audio_path}")
        segments = request.get("segments") or []
        if not isinstance(segments, list):
            raise ValueError("segments must be a list")
        return _diarize_segments(
            config,
            audio_path,
            segments,
            progress_callback,
            str(request.get("cache_key") or "") or None,
        )
    if action == "shutdown":
        # Let normal process teardown release Torch resources after the response
        # has been flushed. Explicit GC here can terminate native worker state
        # before the protocol acknowledgement reaches the parent process.
        return {"shutdown": True}
    raise ValueError(f"unsupported action: {action}")


def _serve_stdio() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request_id: Any = None
        should_stop = False
        try:
            request = json.loads(line)
            request_id = request.get("id")
            should_stop = request.get("action") == "shutdown"
            def emit_progress(progress: int, message: str) -> None:
                _protocol_write(
                    {
                        "id": request_id,
                        "event": "progress",
                        "progress": max(0, min(int(progress), 100)),
                        "message": message,
                    }
                )

            payload = _handle(request, emit_progress)
            response = {"id": request_id, "ok": True, "result": payload}
        except Exception as exc:
            _log(traceback.format_exc())
            response = {
                "id": request_id,
                "ok": False,
                "error": {"type": type(exc).__name__, "message": str(exc)},
            }
        _protocol_write(response)
        if should_stop:
            break


def main() -> None:
    parser = argparse.ArgumentParser(description="CalMee FunASR sidecar")
    parser.add_argument("--stdio", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        from importlib.metadata import version

        import funasr  # noqa: F401
        import modelscope  # noqa: F401
        import pypinyin  # noqa: F401
        import soundfile  # noqa: F401
        import torch
        import torchaudio  # noqa: F401

        print(
            json.dumps(
                {
                    "ok": True,
                    "python": sys.version,
                    "platform": platform.platform(),
                    "funasr": version("funasr"),
                    "modelscope": version("modelscope"),
                    "torch": torch.__version__,
                    "mps_available": bool(
                        hasattr(torch.backends, "mps")
                        and torch.backends.mps.is_available()
                    ),
                }
            )
        )
        return
    if not args.stdio:
        parser.error("--stdio is required")
    _serve_stdio()


if __name__ == "__main__":
    main()
