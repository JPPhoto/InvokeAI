"""A whole clip as LTX-2 conditioning: generate a soundtrack for existing picture."""

import numpy as np
import torch
from PIL import Image

from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    BaseInvocationOutput,
    Classification,
    invocation,
    invocation_output,
)
from invokeai.app.invocations.fields import (
    FieldDescriptions,
    Input,
    InputField,
    LTX2FullVideoConditioningField,
    OutputField,
    VideoField,
)
from invokeai.app.invocations.model import VAEField
from invokeai.app.services.shared.invocation_context import InvocationContext
from invokeai.app.util.video_thumbnails import iter_video_frames
from invokeai.backend.ltx2.constants import (
    LTX2_CANVAS_MULTIPLE,
    LTX2_DEFAULT_TEMPORAL_TILE,
    LTX2_DEFAULT_TILE_SIZE,
    LTX2_FRAME_MODULUS,
    LTX2_LATENT_CHANNELS,
    LTX2_NUM_FRAMES_MAX,
)
from invokeai.backend.ltx2.image_conditioning import fit_to_canvas
from invokeai.backend.ltx2.packing import normalize_video_latents, snap_num_frames_down, video_latent_shape
from invokeai.backend.ltx2.video_decoding import scoped_ltx2_tiling
from invokeai.backend.model_manager.load.model_cache.utils import get_effective_device
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.util.cancel_hooks import cancel_before_forward
from invokeai.backend.util.vae_working_memory import estimate_vae_working_memory_ltx2

# How often the frame-reading loop reports. Decoding and cover-cropping a long clip is tens of
# seconds; without this the bar sits still for all of it.
_PROGRESS_FRAME_INTERVAL = 48


@invocation_output("ltx2_video_conditioning_output")
class LTX2VideoConditioningOutput(BaseInvocationOutput):
    """A clip to generate a soundtrack for, and the geometry it pins."""

    video_conditioning: LTX2FullVideoConditioningField = OutputField(
        description=FieldDescriptions.ltx2_full_video_conditioning, title="Video Conditioning"
    )
    width: int = OutputField(description="Pixel width the clip was encoded at.")
    height: int = OutputField(description="Pixel height the clip was encoded at.")
    num_frames: int = OutputField(description="Frames encoded, snapped down to 8n + 1.")


@invocation(
    "ltx2_video_conditioning",
    title="Video Conditioning - LTX-2",
    tags=["ltx", "ltx2", "video", "audio", "conditioning"],
    category="conditioning",
    version="1.0.0",
    classification=Classification.Prototype,
)
class LTX2VideoConditioningInvocation(BaseInvocation):
    """Encodes a whole clip so LTX-2 can generate a soundtrack for it.

    The mirror of audio conditioning: every video token is held clean at each step and only the
    audio is sampled. The clip decides the generation's geometry -- its canvas, its length and its
    frame rate -- because the picture is a given rather than something being made.

    Frames are fitted to the canvas by cover-crop, as first-frame conditioning does, and the count
    is snapped *down* to the VAE's 8n + 1 grid; trailing frames beyond the last group are dropped
    rather than padded, since padding would invent picture for the model to score sound against.

    What comes back is the model's reconstruction of the clip, not the clip: the picture is
    cover-cropped to the canvas, VAE round-tripped and re-encoded, because the decode node renders
    the held latents like any others. That is the opposite of the choice audio conditioning makes
    for the soundtrack, which is muxed back in as supplied -- the symmetric treatment here would be
    to remux the source video stream, and it is not done yet.

    The encode is tiled, and not by preference: an untiled encode's activation grows with the whole
    clip rather than with one tile, so a 1248x704 clip of 121 frames would need about 65 GiB where
    tiled it needs 3.2, flat in the clip's length. Tiling costs blend seams -- measured at 16%
    relative rms against an untiled encode of the same smooth footage -- which is why the tile
    sizes are inputs rather than constants: a clip that fits a larger tile can be given one.
    """

    video: VideoField = InputField(description="The clip to generate a soundtrack for.")
    vae: VAEField = InputField(description=FieldDescriptions.vae, input=Input.Connection, title="Video VAE")
    width: int = InputField(
        default=768, gt=0, multiple_of=LTX2_CANVAS_MULTIPLE, description="Canvas width to encode at."
    )
    height: int = InputField(
        default=512, gt=0, multiple_of=LTX2_CANVAS_MULTIPLE, description="Canvas height to encode at."
    )
    fps: float = InputField(default=24.0, ge=1, le=120, description="The clip's frame rate, which the audio adopts.")
    tile_size: int = InputField(
        default=LTX2_DEFAULT_TILE_SIZE,
        ge=64,
        description="Spatial encode tile, in source pixels. Smaller tiles need less VRAM and take longer.",
    )
    temporal_tile: int = InputField(
        default=LTX2_DEFAULT_TEMPORAL_TILE,
        ge=8,
        description="Temporal encode tile, in source frames. Smaller tiles need less VRAM and take longer.",
    )

    @torch.no_grad()
    def invoke(self, context: InvocationContext) -> LTX2VideoConditioningOutput:
        path = context.videos.get_path(self.video.video_name)
        vae_info = context.models.load(self.vae.vae)
        if vae_info.config.base is not BaseModelType.LTX2:
            raise ValueError(f"Expected an LTX-2 video VAE; got a {vae_info.config.base.value} one.")

        # A ceiling, and it stops the decode rather than checking after the fact: nothing upstream
        # bounds a clip's length -- `validate_num_frames` only checks the 8n + 1 grid -- so a
        # workflow handing this node a ten-minute recording would otherwise materialize every frame
        # before anything refused it. The cap is the grid value at or below the model's own maximum.
        cap = snap_num_frames_down(LTX2_NUM_FRAMES_MAX)
        context.util.signal_progress("Reading the clip for LTX-2 conditioning")
        # `fit_to_canvas` takes (height, width) and a PIL image, and already returns RGB.
        frames: list[np.ndarray] = []
        for frame in iter_video_frames(path, is_canceled=context.util.is_canceled):
            frames.append(np.asarray(fit_to_canvas(Image.fromarray(frame), self.height, self.width), dtype=np.uint8))
            if len(frames) >= cap:
                break
            if len(frames) % _PROGRESS_FRAME_INTERVAL == 0:
                context.util.signal_progress(f"Reading the clip for LTX-2 conditioning ({len(frames)} frames)")

        num_frames = snap_num_frames_down(len(frames))
        if num_frames < 1 + LTX2_FRAME_MODULUS:
            raise ValueError(
                f"'{self.video.video_name}' decoded to {len(frames)} frame(s), which is under one frame group. "
                f"Use a longer clip."
            )
        del frames[num_frames:]

        # Stacked as uint8 and converted on the device: the fp32 copy is four times the size, and
        # making it here would put ~2.4 GiB of host memory (for a 241-frame 1248x704 clip) outside
        # every budget the model cache knows about, on top of the list it is built from.
        pixels = torch.from_numpy(np.stack(frames))
        del frames

        # Tiled, like the decode: an untiled encode's activation grows with the whole clip rather
        # than with one tile, and a 1248x704 clip of 121 frames needs about 65 GiB of it. Tiled at
        # the defaults the same encode runs in 3.2 GiB, and the cost is flat in the clip's length.
        working_memory = estimate_vae_working_memory_ltx2(
            "encode",
            vae_info.model,
            pixel_height=self.height,
            pixel_width=self.width,
            pixel_frames=num_frames,
            tile_size=self.tile_size,
            temporal_tile=self.temporal_tile,
            tiled=True,
        )
        context.util.signal_progress("Encoding the clip for LTX-2 conditioning")

        with vae_info.model_on_device(working_mem_bytes=working_memory) as (_, vae):
            vae_dtype = next(iter(vae.parameters())).dtype
            # Resolved again inside the lock: the cache decides where the model actually lands, and
            # a partially-loaded or CPU-resident VAE would reject input placed on the accelerator.
            device = get_effective_device(vae)
            source = pixels.to(device=device).permute(3, 0, 1, 2).unsqueeze(0)  # [1, 3, T, H, W]
            # Subtract before dividing: the arithmetic runs in the VAE's own (low-precision) dtype
            # to keep one copy of the clip rather than two, and `x / 127.5 - 1` cancels there --
            # mid-grey lands within a bf16 ulp of 1.0, so the subtraction throws the value away.
            # This order is the same maths with no cancellation, and matches an fp32 round-trip.
            source = source.to(dtype=vae_dtype).sub_(127.5).div_(127.5)
            del pixels

            with (
                scoped_ltx2_tiling(vae, tile_size=self.tile_size, temporal_tile=self.temporal_tile),
                # One poll per encoder forward: a tiled encode of a long clip is hundreds of them,
                # and polling only around the whole call would leave a cancel waiting for all of it.
                cancel_before_forward([vae.encoder], context.util.is_canceled, device),
            ):
                latents = vae.encode(source).latent_dist.mode().to(torch.float32)
            del source
            latents = normalize_video_latents(
                latents, vae.latents_mean, vae.latents_std, float(vae.config.scaling_factor)
            )

        expected = (1, LTX2_LATENT_CHANNELS, *video_latent_shape(num_frames, self.height, self.width))
        if tuple(latents.shape) != expected:
            raise ValueError(
                f"The clip encoded to {tuple(latents.shape)} but {self.width}x{self.height} at {num_frames} "
                f"frames needs {expected}."
            )

        return LTX2VideoConditioningOutput(
            video_conditioning=LTX2FullVideoConditioningField(
                latents_name=context.tensors.save(tensor=latents.cpu()),
                width=self.width,
                height=self.height,
                num_frames=num_frames,
                fps=self.fps,
            ),
            width=self.width,
            height=self.height,
            num_frames=num_frames,
        )
