"""LTX-2 denoise: joint video and audio sampling from one transformer."""

from typing import Literal

import torch
from tqdm import tqdm

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
    LatentsField,
    LTX2ConditioningField,
    LTX2VideoConditioningField,
    OutputField,
)
from invokeai.app.invocations.model import LTX2TransformerField
from invokeai.app.services.shared.invocation_context import InvocationContext
from invokeai.app.util.misc import SEED_MAX
from invokeai.backend.ltx2.constants import (
    LTX2_AUDIO_CFG_SCALE,
    LTX2_CANVAS_MULTIPLE,
    LTX2_CFG_SCALE,
    LTX2_DEFAULT_FPS,
    LTX2_DEFAULT_NUM_FRAMES,
    LTX2_DEV_STEPS,
    LTX2_DISTILLED_STEPS,
    LTX2_GUIDANCE_RESCALE,
    LTX2_MODALITY_SCALE,
    LTX2_STG_SCALE,
)
from invokeai.backend.ltx2.denoise import build_denoise_state, denoise, preview_latent_frame
from invokeai.backend.ltx2.guidance import LTX2Guidance
from invokeai.backend.ltx2.packing import (
    require_patch_geometry,
    unpack_video_latents,
    validate_num_frames,
    video_sequence_length,
)
from invokeai.backend.model_manager.taxonomy import BaseModelType, LTX2VariantType
from invokeai.backend.quantization.dequantizing_linear import peak_dequant_transient_bytes
from invokeai.backend.stable_diffusion.diffusers_pipeline import PipelineIntermediateState
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import LTX2ConditioningInfo
from invokeai.backend.util.devices import TorchDevice

LTX2Schedule = Literal["auto", "dev", "distilled"]

LTX2_SCHEDULE_LABELS: dict[str, str] = {
    "auto": "Auto (from the model's variant)",
    "dev": "Dev (shifted, guided)",
    "distilled": "Distilled (8 fixed steps, no guidance)",
}


@invocation_output("ltx2_denoise_output")
class LTX2DenoiseOutput(BaseInvocationOutput):
    """Joint video and audio latents from one LTX-2 denoise run."""

    video_latents: LatentsField = OutputField(description="Video latents [1, 128, T_lat, H/32, W/32].")
    audio_latents: LatentsField = OutputField(description="Packed audio latents [1, T_audio, 128].")
    width: int = OutputField(description="Pixel width of the video latents.")
    height: int = OutputField(description="Pixel height of the video latents.")
    num_frames: int = OutputField(description="Pixel-frame count of the video latents.")


@invocation(
    "ltx2_denoise",
    title="Denoise - LTX-2",
    tags=["ltx", "ltx2", "video", "audio", "denoise"],
    category="latents",
    version="1.0.0",
    classification=Classification.Prototype,
)
class LTX2DenoiseInvocation(BaseInvocation):
    """Generates LTX-2 video and audio latents together.

    One transformer forward produces both modalities at every step, so the soundtrack is generated
    with the picture rather than dubbed onto it. Wire an image conditioning to start the clip from
    a frame.

    The guidance-distilled checkpoint runs a fixed eight-step schedule with no guidance at all: its
    step count and guidance scales below are ignored, and the negative prompt never reaches it.
    """

    transformer: LTX2TransformerField = InputField(
        description=FieldDescriptions.ltx2_model, input=Input.Connection, title="Transformer"
    )
    positive_conditioning: LTX2ConditioningField = InputField(
        description=FieldDescriptions.positive_cond, input=Input.Connection
    )
    negative_conditioning: LTX2ConditioningField | None = InputField(
        default=None,
        description="Conditioning for the unconditional pass. Required whenever a guidance scale is above 1.",
        input=Input.Connection,
    )
    video_conditioning: LTX2VideoConditioningField | None = InputField(
        default=None,
        description=FieldDescriptions.ltx2_video_conditioning,
        input=Input.Connection,
        title="Image Conditioning",
    )
    width: int = InputField(default=1248, gt=0, multiple_of=LTX2_CANVAS_MULTIPLE, description="Canvas width.")
    height: int = InputField(default=704, gt=0, multiple_of=LTX2_CANVAS_MULTIPLE, description="Canvas height.")
    num_frames: int = InputField(
        default=LTX2_DEFAULT_NUM_FRAMES,
        gt=0,
        description="Frames to generate. The causal VAE encodes the first frame alone and then groups of "
        "eight, so this must be 8n + 1.",
    )
    fps: float = InputField(
        default=LTX2_DEFAULT_FPS,
        ge=1,
        le=120,
        description="Frames per second. Sets the clip's duration, which is also what the audio stream is "
        "generated to fill, and the transformer's positional clock.",
    )
    steps: int = InputField(default=LTX2_DEV_STEPS, gt=0, description="Number of denoising steps.")
    cfg_scale: float = InputField(
        default=LTX2_CFG_SCALE, ge=1.0, description="Classifier-free guidance scale for the video stream."
    )
    audio_cfg_scale: float = InputField(
        default=LTX2_AUDIO_CFG_SCALE,
        ge=1.0,
        description="Classifier-free guidance scale for the audio stream. The release guides audio much "
        "harder than video.",
        title="Audio CFG Scale",
    )
    stg_scale: float = InputField(
        default=LTX2_STG_SCALE,
        ge=0.0,
        description="Spatio-temporal guidance scale. Steers away from a pass whose self-attention is skipped "
        "in one block, which sharpens motion. 0 turns it off and saves a forward per step.",
        title="STG Scale",
    )
    modality_scale: float = InputField(
        default=LTX2_MODALITY_SCALE,
        ge=1.0,
        description="Modality-isolation guidance scale. Steers away from a pass with the audio/video "
        "cross-attention disabled, which tightens the two streams' agreement. 1 turns it off.",
    )
    guidance_rescale: float = InputField(
        default=LTX2_GUIDANCE_RESCALE,
        ge=0.0,
        le=1.0,
        description="How far to pull the guided prediction's contrast back toward the unguided one.",
    )
    schedule: LTX2Schedule = InputField(
        default="auto",
        description="Which noise schedule to sample. 'Auto' follows the loaded transformer's variant.",
        ui_choice_labels=LTX2_SCHEDULE_LABELS,
    )
    seed: int = InputField(default=0, ge=0, le=SEED_MAX, description="Randomness seed for reproducibility.")

    @staticmethod
    def _estimate_working_memory(video_rows: int, audio_rows: int) -> int:
        """Estimate peak transformer activation bytes so the model cache reserves enough headroom.

        The 22B transformer is partially loaded on any card this runs on, and without a hint the
        cache reserves only its small default, packs VRAM with weights, and the first forward dies.

        Attention runs through SDPA without materializing scores, so activations scale linearly with
        the packed row count: per video row the concurrently live bf16 terms inside one block are
        the 4096-wide QKV and attention output and the gelu feed-forward's intermediates. Audio rows
        are the same shape at half the width, and there are two orders of magnitude fewer of them.
        Guidance passes run one after another rather than as one batch, so they do not multiply the
        peak; the per-pass x0 predictions that are all live at the combine are one float32 row each
        and are inside the constants below.

        Measured on a W7900 (gfx1100, released int8-convrot dev transformer, four guidance passes),
        as peak *reserved* minus the resident model: 0.46 GiB at 320 video rows (512x320x9) and
        2.81 GiB at 13728 (1248x704x121), which fits a 0.18 MiB/row line through a 0.40 GiB
        intercept. The constants round that up, and the base additionally covers block weights
        arriving on device under partial loading, which a fully resident measurement does not see.
        """
        MiB = 1024**2
        return video_rows * (MiB // 5) + audio_rows * (MiB // 10) + 1024**3

    def _resolve_distilled(self) -> bool:
        if self.schedule != "auto":
            return self.schedule == "distilled"
        if self.transformer.variant is None:
            raise ValueError(
                "The schedule is set to Auto but the transformer carries no variant, so there is nothing to "
                "follow. Choose 'Dev' or 'Distilled' explicitly."
            )
        return self.transformer.variant == LTX2VariantType.Distilled.value

    def _resolve_guidance(self, context: InvocationContext, distilled: bool) -> LTX2Guidance:
        if distilled:
            # Not a preference the user can override: the distilled checkpoint has guidance baked
            # into its weights, and steering it produces a saturated, broken clip.
            requested = (self.cfg_scale, self.audio_cfg_scale, self.stg_scale, self.modality_scale)
            if requested != (1.0, 1.0, 0.0, 1.0):
                context.logger.info(
                    "The distilled LTX-2 checkpoint is guidance-distilled; ignoring the guidance scales on "
                    "this node and running one forward per step."
                )
            return LTX2Guidance(cfg_scale=1.0, audio_cfg_scale=1.0, stg_scale=0.0, modality_scale=1.0, rescale=0.0)
        return LTX2Guidance(
            cfg_scale=self.cfg_scale,
            audio_cfg_scale=self.audio_cfg_scale,
            stg_scale=self.stg_scale,
            modality_scale=self.modality_scale,
            rescale=self.guidance_rescale,
        )

    def _load_conditioning(self, context: InvocationContext, field: LTX2ConditioningField) -> LTX2ConditioningInfo:
        data = context.conditioning.load(field.conditioning_name)
        assert len(data.conditionings) == 1
        info = data.conditionings[0]
        assert isinstance(info, LTX2ConditioningInfo)
        return info

    def _load_image_latents(self, context: InvocationContext) -> torch.Tensor | None:
        if self.video_conditioning is None:
            return None
        if (self.video_conditioning.width, self.video_conditioning.height) != (self.width, self.height):
            raise ValueError(
                f"The image conditioning was prepared for a {self.video_conditioning.width}x"
                f"{self.video_conditioning.height} canvas but this denoise runs at {self.width}x{self.height}. "
                "Re-run Image Conditioning - LTX-2 with matching width and height."
            )
        return context.tensors.load(self.video_conditioning.latents_name)

    @torch.no_grad()
    def invoke(self, context: InvocationContext) -> LTX2DenoiseOutput:
        # The canvas is checked by the fields themselves (`multiple_of`), so a bad one never
        # enqueues; the frame grid cannot be expressed that way, and checking it here is what stops
        # a mistyped count from loading a 12B encoder and a 22B transformer before it is refused.
        # `build_denoise_state` checks both again for callers that do not come through this node.
        validate_num_frames(self.num_frames)

        distilled = self._resolve_distilled()
        guidance = self._resolve_guidance(context, distilled)
        if distilled and self.steps != LTX2_DISTILLED_STEPS:
            context.logger.info(
                f"The distilled LTX-2 schedule is a fixed {LTX2_DISTILLED_STEPS} steps; ignoring the "
                f"{self.steps} requested."
            )

        positive = self._load_conditioning(context, self.positive_conditioning)
        negative = None
        if guidance.needs_negative_conditioning:
            if self.negative_conditioning is None:
                raise ValueError(
                    "Classifier-free guidance is on (a CFG scale above 1) but no negative conditioning is "
                    "wired. Connect Prompt - LTX-2's negative output, or set both CFG scales to 1."
                )
            negative = self._load_conditioning(context, self.negative_conditioning)

        state = build_denoise_state(
            num_frames=self.num_frames,
            height=self.height,
            width=self.width,
            fps=self.fps,
            seed=self.seed,
            distilled=distilled,
            num_steps=self.steps,
            image_latents=self._load_image_latents(context),
            conditioning_strength=self.video_conditioning.strength if self.video_conditioning else 1.0,
        )

        device = TorchDevice.choose_torch_device()
        inference_dtype = TorchDevice.choose_bfloat16_safe_dtype(device)
        estimated_working_memory = self._estimate_working_memory(
            video_sequence_length(self.num_frames, self.height, self.width), state.audio_latents_count
        )

        transformer_info = context.models.load(self.transformer.transformer)
        # An int8-convrot build materializes each linear's dequantized weight inside the forward,
        # which the model's resident size does not account for. Read from the unlocked model, before
        # the VRAM lock the reservation applies to; zero on a bf16 build.
        estimated_working_memory += peak_dequant_transient_bytes(transformer_info.model, inference_dtype)

        with transformer_info.model_on_device(working_mem_bytes=estimated_working_memory) as (_, transformer):
            require_patch_geometry(transformer.config)
            context.util.signal_progress("Denoising LTX-2 audio-video")
            progress = tqdm(total=state.num_steps, desc=f"Denoising LTX-2 ({self.num_frames} frames)")

            def step_callback(step: int, total_steps: int, video_x0: torch.Tensor) -> None:
                progress.update(1)
                context.util.sd_step_callback(
                    PipelineIntermediateState(
                        step=step,
                        order=1,
                        total_steps=total_steps,
                        timestep=0,
                        latents=preview_latent_frame(video_x0, state),
                    ),
                    BaseModelType.LTX2,
                )

            try:
                video_latents, audio_latents = denoise(
                    transformer=transformer,
                    state=state,
                    positive=positive,
                    negative=negative,
                    guidance=guidance,
                    fps=self.fps,
                    dtype=inference_dtype,
                    device=device,
                    step_callback=step_callback,
                    is_canceled=context.util.is_canceled,
                )
            finally:
                progress.close()

        video_5d = unpack_video_latents(video_latents, state.latent_frames, state.latent_height, state.latent_width)
        return LTX2DenoiseOutput(
            video_latents=LatentsField(
                latents_name=context.tensors.save(tensor=video_5d.detach().to(device="cpu", dtype=torch.float32)),
                seed=self.seed,
            ),
            audio_latents=LatentsField(
                latents_name=context.tensors.save(tensor=audio_latents.detach().to(device="cpu", dtype=torch.float32)),
                seed=self.seed,
            ),
            width=self.width,
            height=self.height,
            num_frames=self.num_frames,
        )
