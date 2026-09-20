"""LTX-2 latent geometry: canvas rules, packing and the VAE's latent normalization.

The transformer runs over two flat token sequences, one per modality. Video latents
``[B, 128, F, H, W]`` become ``[B, F*H*W, 128]`` and audio latents ``[B, 8, L, 16]`` become
``[B, L, 128]``; both packings are the reference implementation's, which at LTX-2.5's 1x1x1
transformer patch size reduce to a reshape and a permute. :func:`require_patch_geometry` refuses a
checkpoint that patches differently rather than letting a wrong packing reach the model.

Packed latents are also *normalized*: the VAE's per-channel statistics are what the transformer was
trained on, and the VAE decodes the raw scale, so every hand-off between them passes through one of
the four functions here.
"""

import math

import torch

from invokeai.backend.ltx2.constants import (
    LTX2_AUDIO_LATENT_MEL_BINS,
    LTX2_AUDIO_LATENTS_PER_SECOND,
    LTX2_CANVAS_MULTIPLE,
    LTX2_FRAME_MODULUS,
    LTX2_PATCH_SIZE,
    LTX2_PATCH_SIZE_T,
    LTX2_SPATIAL_COMPRESSION,
    LTX2_TEMPORAL_COMPRESSION,
)


def require_patch_geometry(transformer_config) -> None:
    """Refuse a transformer whose patch sizes this module's packing does not implement.

    Everything here assumes LTX-2.5's 1x1x1 patching. A checkpoint that patched 2x2 would pack to a
    different sequence length *and* a different row width, which the model would accept as a shape
    mismatch deep inside the first projection rather than as a named error here.
    """
    patch_size = int(getattr(transformer_config, "patch_size", LTX2_PATCH_SIZE))
    patch_size_t = int(getattr(transformer_config, "patch_size_t", LTX2_PATCH_SIZE_T))
    if (patch_size, patch_size_t) != (LTX2_PATCH_SIZE, LTX2_PATCH_SIZE_T):
        raise ValueError(
            f"This LTX-2 transformer patches the latent grid at {patch_size_t}x{patch_size}x{patch_size}; "
            f"only {LTX2_PATCH_SIZE_T}x{LTX2_PATCH_SIZE}x{LTX2_PATCH_SIZE} (LTX-2.5) is supported."
        )


def validate_canvas(height: int, width: int) -> None:
    if height <= 0 or width <= 0:
        raise ValueError(f"LTX-2 canvas must be positive; got {width}x{height}.")
    if height % LTX2_CANVAS_MULTIPLE or width % LTX2_CANVAS_MULTIPLE:
        raise ValueError(
            f"LTX-2 width and height must be multiples of {LTX2_CANVAS_MULTIPLE} (the VAE's spatial "
            f"compression); got {width}x{height}."
        )


def validate_num_frames(num_frames: int) -> None:
    if num_frames < 1 or (num_frames - 1) % LTX2_FRAME_MODULUS:
        nearest = max(1, round((num_frames - 1) / LTX2_FRAME_MODULUS)) * LTX2_FRAME_MODULUS + 1
        raise ValueError(
            f"LTX-2 needs {LTX2_FRAME_MODULUS}n + 1 frames (the causal VAE encodes the first frame "
            f"alone, then groups of {LTX2_FRAME_MODULUS}); got {num_frames}. The nearest valid count "
            f"is {nearest}."
        )


def snap_num_frames(num_frames: int) -> int:
    """The nearest valid frame count at or above 1, rounding a tie up.

    Half-up rather than Python's half-to-even: a 5-frame request is equidistant from 1 and 9, and
    collapsing it to a single still frame is not what the request meant.
    """
    groups = max(0, math.floor((num_frames - 1) / LTX2_FRAME_MODULUS + 0.5))
    return groups * LTX2_FRAME_MODULUS + 1


def latent_frame_count(num_frames: int) -> int:
    return (num_frames - 1) // LTX2_TEMPORAL_COMPRESSION + 1


def video_latent_shape(num_frames: int, height: int, width: int) -> tuple[int, int, int]:
    """``(latent frames, latent height, latent width)`` for a validated pixel canvas."""
    return (
        latent_frame_count(num_frames),
        height // LTX2_SPATIAL_COMPRESSION,
        width // LTX2_SPATIAL_COMPRESSION,
    )


def video_sequence_length(num_frames: int, height: int, width: int) -> int:
    latent_frames, latent_height, latent_width = video_latent_shape(num_frames, height, width)
    return latent_frames * latent_height * latent_width


def audio_latent_count(num_frames: int, fps: float) -> int:
    """The audio latent count covering a clip's duration, on the audio VAE's 25-latents/s grid."""
    if fps <= 0:
        raise ValueError(f"LTX-2 frame rate must be positive; got {fps}.")
    return round(num_frames / fps * LTX2_AUDIO_LATENTS_PER_SECOND)


def pack_video_latents(latents: torch.Tensor) -> torch.Tensor:
    """``[B, C, F, H, W]`` -> ``[B, F*H*W, C]`` in frame-major, then row-major, order."""
    batch_size, _, num_frames, height, width = latents.shape
    latents = latents.reshape(batch_size, -1, num_frames, 1, height, 1, width, 1)
    return latents.permute(0, 2, 4, 6, 1, 3, 5, 7).flatten(4, 7).flatten(1, 3)


def unpack_video_latents(latents: torch.Tensor, num_frames: int, height: int, width: int) -> torch.Tensor:
    """``[B, F*H*W, C]`` -> ``[B, C, F, H, W]``, the inverse of :func:`pack_video_latents`."""
    batch_size = latents.size(0)
    latents = latents.reshape(batch_size, num_frames, height, width, -1, 1, 1, 1)
    return latents.permute(0, 4, 1, 5, 2, 6, 3, 7).flatten(6, 7).flatten(4, 5).flatten(2, 3)


def pack_audio_latents(latents: torch.Tensor) -> torch.Tensor:
    """``[B, C, L, M]`` -> ``[B, L, C*M]``: one row per audio latent, mel bins inside channels."""
    return latents.transpose(1, 2).flatten(2, 3)


def unpack_audio_latents(latents: torch.Tensor, mel_bins: int = LTX2_AUDIO_LATENT_MEL_BINS) -> torch.Tensor:
    """``[B, L, C*M]`` -> ``[B, C, L, M]``, the inverse of :func:`pack_audio_latents`."""
    return latents.unflatten(2, (-1, mel_bins)).transpose(1, 2)


def normalize_video_latents(
    latents: torch.Tensor, latents_mean: torch.Tensor, latents_std: torch.Tensor, scaling_factor: float = 1.0
) -> torch.Tensor:
    """Raw VAE latents ``[B, C, F, H, W]`` -> the transformer's per-channel normalized scale."""
    mean = latents_mean.view(1, -1, 1, 1, 1).to(latents.device, latents.dtype)
    std = latents_std.view(1, -1, 1, 1, 1).to(latents.device, latents.dtype)
    return (latents - mean) * scaling_factor / std


def denormalize_video_latents(
    latents: torch.Tensor, latents_mean: torch.Tensor, latents_std: torch.Tensor, scaling_factor: float = 1.0
) -> torch.Tensor:
    mean = latents_mean.view(1, -1, 1, 1, 1).to(latents.device, latents.dtype)
    std = latents_std.view(1, -1, 1, 1, 1).to(latents.device, latents.dtype)
    return latents * std / scaling_factor + mean


def denormalize_audio_latents(
    latents: torch.Tensor, latents_mean: torch.Tensor, latents_std: torch.Tensor
) -> torch.Tensor:
    """Normalized *packed* audio latents ``[B, L, 128]`` -> the audio VAE's own scale.

    Unlike the video statistics, the audio VAE's are per packed row element -- the released file
    stores 128 of them, one per (channel, mel bin) pair -- so audio latents are denormalized before
    being unpacked, and would be packed before being normalized.
    """
    return latents * latents_std.to(latents.device, latents.dtype) + latents_mean.to(latents.device, latents.dtype)


def resolve_canvas(source_width: float, source_height: float, short_edge: int) -> tuple[int, int]:
    """``(height, width)`` for a source aspect ratio with its short edge pinned to ``short_edge``.

    Both axes are rounded to the canvas multiple, half to even so a ratio exactly between two grid
    points does not systematically grow. Only the ratio of the inputs matters.
    """
    if source_width <= 0 or source_height <= 0:
        raise ValueError(f"Source dimensions must be positive; got {source_width}x{source_height}.")
    if short_edge <= 0 or short_edge % LTX2_CANVAS_MULTIPLE:
        raise ValueError(f"Short edge must be a positive multiple of {LTX2_CANVAS_MULTIPLE}; got {short_edge}.")

    aspect = source_width / source_height
    if aspect >= 1.0:
        height, width = float(short_edge), short_edge * aspect
    else:
        height, width = short_edge / aspect, float(short_edge)
    return _snap_axis(height), _snap_axis(width)


def _snap_axis(value: float) -> int:
    # round() is half-to-even, which is the behaviour the frontend's resolver mirrors.
    return max(LTX2_CANVAS_MULTIPLE, round(value / LTX2_CANVAS_MULTIPLE) * LTX2_CANVAS_MULTIPLE)
