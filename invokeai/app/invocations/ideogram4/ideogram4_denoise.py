from contextlib import ExitStack
from typing import Literal, Optional

import torch

from invokeai.app.invocations.baseinvocation import BaseInvocation, Classification, invocation
from invokeai.app.invocations.fields import (
    FieldDescriptions,
    Ideogram4ConditioningField,
    Input,
    InputField,
)
from invokeai.app.invocations.model import TransformerField
from invokeai.app.invocations.primitives import LatentsOutput
from invokeai.app.services.shared.invocation_context import InvocationContext
from invokeai.backend.architectures import resolve_latent_space
from invokeai.backend.ideogram4 import run_ideogram4_denoise
from invokeai.backend.ideogram4.latent_norm import get_latent_norm
from invokeai.backend.ideogram4.modeling_ideogram4 import Ideogram4Transformer
from invokeai.backend.ideogram4.sampler_configs import PRESETS
from invokeai.backend.ideogram4.sampling_utils import PIXELS_PER_IMAGE_TOKEN, unpatchify_and_denormalize
from invokeai.backend.ideogram4.transformer_pair import Ideogram4TransformerPair
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.quantization.dequantizing_linear import peak_dequant_transient_bytes
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import Ideogram4ConditioningInfo
from invokeai.backend.util.devices import TorchDevice
from invokeai.backend.util.fp8 import get_model_compute_dtype

# Named sampler presets bundle step count, guidance schedule (with polish tail), and the
# logit-normal schedule mean/std. V4_QUALITY_48 is the reference default.
IDEOGRAM4_SAMPLER_PRESETS = Literal["V4_QUALITY_48", "V4_DEFAULT_20", "V4_TURBO_12"]


def _effective_guidance_schedule(
    base_schedule: tuple[float, ...], preset_num_steps: int, num_steps: int, guidance_scale: Optional[float]
) -> tuple[float, ...]:
    """Build the per-step guidance schedule for the (possibly overridden) step count.

    The preset schedule is ``(polish_gw,)*N_polish + (main_gw,)*N_main`` in loop-index order
    (index 0 = the final/polish step). A ``guidance_scale`` override replaces the main weight while
    the preset's polish tail is preserved; a changed step count rescales the polish tail
    proportionally (always keeping at least one polish and one main step).

    ``num_steps`` must be >= 2 (enforced by the invocation's ``steps`` field) so both a polish and a
    main step always exist — otherwise a single step would be all-polish and silently drop the
    ``guidance_scale`` override.
    """
    polish_gw = base_schedule[0]
    main_gw = float(guidance_scale) if guidance_scale is not None else float(base_schedule[-1])
    if num_steps == preset_num_steps and guidance_scale is None:
        return base_schedule
    n_polish_base = sum(1 for gw in base_schedule if gw == base_schedule[0])
    # Cap the polish tail at num_steps - 1 so at least one main step always remains and the
    # guidance_scale override is never silently dropped.
    polish_count = max(1, min(round(n_polish_base * num_steps / preset_num_steps), num_steps - 1))
    main_count = num_steps - polish_count
    return (polish_gw,) * polish_count + (main_gw,) * main_count


@invocation(
    "ideogram4_denoise",
    title="Denoise - Ideogram 4",
    tags=["image", "ideogram4"],
    category="latents",
    version="1.1.0",
    classification=Classification.Prototype,
)
class Ideogram4DenoiseInvocation(BaseInvocation):
    """Runs the Ideogram 4 dual-branch flow-matching denoising loop (text-to-image)."""

    transformer: TransformerField = InputField(
        description=FieldDescriptions.transformer, input=Input.Connection, title="Transformer"
    )
    unconditional_transformer: Optional[TransformerField] = InputField(
        default=None,
        description="The unconditional branch when it is a separate single-file model. Leave "
        "unconnected for a diffusers pipeline, whose Transformer submodel carries both branches.",
        input=Input.Connection,
        title="Transformer (Unconditional)",
    )
    positive_conditioning: Ideogram4ConditioningField = InputField(
        description=FieldDescriptions.positive_cond, input=Input.Connection
    )
    sampler_preset: IDEOGRAM4_SAMPLER_PRESETS = InputField(
        default="V4_QUALITY_48",
        description="Sampler preset (steps + guidance schedule + schedule mean/std).",
        title="Sampler Preset",
    )
    width: int = InputField(default=1024, multiple_of=16, description="Width of the generated image.")
    height: int = InputField(default=1024, multiple_of=16, description="Height of the generated image.")
    seed: int = InputField(default=0, description="Randomness seed for reproducibility.")
    # Optional advanced overrides of the sampler preset. None = use the preset's value.
    steps: Optional[int] = InputField(
        default=None,
        ge=2,
        le=100,
        description="Override the preset's step count (minimum 2, so a polish and a main step both "
        "exist). Leave empty to use the preset.",
    )
    guidance_scale: Optional[float] = InputField(
        default=None,
        ge=1.0,
        le=20.0,
        description="Override the main guidance weight (the preset's polish tail is preserved). "
        "Empty = use the preset.",
    )
    mu: Optional[float] = InputField(
        default=None,
        ge=-4.0,
        le=4.0,
        description="Override the logit-normal schedule mean (resolution-adjusted internally). Empty = use the preset.",
    )

    @torch.no_grad()
    def invoke(self, context: InvocationContext) -> LatentsOutput:
        device = TorchDevice.choose_torch_device()
        preset = PRESETS[self.sampler_preset]

        # Apply optional advanced overrides on top of the preset.
        num_steps = self.steps if self.steps is not None else preset.num_steps
        mu = self.mu if self.mu is not None else preset.mu
        guidance_schedule = _effective_guidance_schedule(
            preset.guidance_schedule, preset.num_steps, num_steps, self.guidance_scale
        )

        # Load conditioning (the stacked Qwen3-VL features).
        cond_data = context.conditioning.load(self.positive_conditioning.conditioning_name)
        assert len(cond_data.conditionings) == 1
        info = cond_data.conditionings[0]
        assert isinstance(info, Ideogram4ConditioningInfo)
        llm_features = info.prompt_embeds.to(device=device, dtype=torch.float32)

        # Denormalization params come from get_latent_norm (no VAE).
        latent_shift, latent_scale = get_latent_norm()

        def step_callback(step: int, total: int, packed_latents: torch.Tensor) -> None:
            # The projection and the downscale come from what this architecture declares, which is
            # the same source the shared denoise callback reads. This was a second copy of the
            # FLUX.2 constants with the 8x downscale hardcoded — and Ideogram 4 was missing from
            # that shared dispatch entirely, so reading either one could not have revealed the other.
            preview = None
            preview_size = None
            try:
                # packed_latents: (1, LATENT_DIM, grid_h, grid_w) -> VAE latent (1, 32, H/8, W/8).
                vae_latent = unpatchify_and_denormalize(
                    packed_latents.float(),
                    latent_shift.to(packed_latents.device),
                    latent_scale.to(packed_latents.device),
                )
                latent_space = resolve_latent_space(BaseModelType.Ideogram4, vae_latent)
                preview = latent_space.preview(vae_latent)
                preview_size = (
                    preview.width * latent_space.spatial_compression,
                    preview.height * latent_space.spatial_compression,
                )
            except Exception:
                # A preview must never break generation — fall back to a plain progress signal.
                preview = None
            if preview is not None:
                context.util.signal_progress(
                    "Running Ideogram 4 denoising",
                    step / total,
                    preview,
                    preview_size,
                )
            else:
                context.util.signal_progress("Running Ideogram 4 denoising", step / total)

        with ExitStack() as stack:
            conditional, unconditional = self._load_branches(
                context, stack, self._estimate_working_memory(int(llm_features.shape[0]))
            )
            packed = run_ideogram4_denoise(
                conditional_transformer=conditional,
                unconditional_transformer=unconditional,
                llm_features=llm_features,
                height=self.height,
                width=self.width,
                num_steps=num_steps,
                mu=mu,
                std=preset.std,
                guidance_schedule=guidance_schedule,
                seed=self.seed,
                device=device,
                step_callback=step_callback,
            )

        packed = packed.detach().to("cpu")
        name = context.tensors.save(tensor=packed)
        return LatentsOutput.build(latents_name=name, latents=packed, seed=None)

    def _estimate_working_memory(self, num_text_tokens: int) -> int:
        """Activation headroom to reserve, in bytes, so the cache does not fill VRAM with weights.

        Without a reservation the cache loads both branches up to the last free byte, and the
        activations then evict the very weights being used: on a 24 GB card the single-file fp8
        pair (17.5 GB resident) spent minutes per step at 94 W, i.e. copying rather than computing.

        Two contributions, both linear in the sequence length:

        * the transformer's own activations (residual stream at 4608 plus one block's attention and
          SwiGLU intermediates) — Krea-2's estimator measures 0.5 MB/token for a comparable MMDiT and
          this model is the same order;
        * Ideogram's conditioning buffers, which are unusually large: `llm_features` is 53248 wide,
          and the loop materializes one buffer over the full packed sequence plus a second over the
          image tokens alone (2 x 53248 x 2 bytes ~ 0.2 MB/token).

        The fixed base covers what does not scale with resolution (fp8 weight-cast transients, the
        VAE-free denormalisation buffers, allocator slack).

        Deliberately not clamped, and the consequence is worth stating. Ideogram 4 is the only
        architecture here that keeps *two* transformers resident, so on a 24 GB card with the fp8
        pair (~17.4 GiB) the headroom runs out somewhere above 1300px: past that the cache cannot
        satisfy the reservation, the second branch loses residency and streams. That is not the
        estimate being wrong -- the memory genuinely is not there -- and reserving less would only
        exchange a slow generation for an out-of-memory error, and the remedy is fewer resident
        bytes rather than a smaller number here. The int8 build does not supply them: 8.9 GiB per
        branch against fp8's 8.7, and fp8 reaches that with `fp8_compute` *or* with FP8 Storage,
        which installation switches on for such a file and which keeps the same weights without the
        matmul. What int8 buys is that this holds on *every* device: with neither of those two the
        fp8 pair expands to 17.3 GiB per branch, and a 24 GB card then runs out of memory during the
        first step.
        """
        image_tokens = (self.height // PIXELS_PER_IMAGE_TOKEN) * (self.width // PIXELS_PER_IMAGE_TOKEN)
        per_token_bytes = 3 * 1024**2 // 4  # 0.75 MiB
        base_bytes = 3 * 1024**3 // 2  # 1.5 GiB
        return (image_tokens + num_text_tokens) * per_token_bytes + base_bytes

    @staticmethod
    def _dequant_transient(model: object) -> int:
        """What an int8 build transiently needs to dequantize its largest layer, per forward.

        `Int8ConvrotLinear` keeps the stored codes and materializes the dequantized, derotated
        weight inside `forward`, so that peak is not part of the model's resident size and has to
        fit inside the caller's reservation. Zero for a bf16 or fp8 build -- which is why it is
        measured from the model rather than from the resolution: the two branches are separate
        models and may be different builds.
        """
        if not isinstance(model, torch.nn.Module):
            return 0
        return peak_dequant_transient_bytes(model, get_model_compute_dtype(model))

    def _load_branches(
        self, context: InvocationContext, stack: ExitStack, working_mem_bytes: int
    ) -> tuple[Ideogram4Transformer, Ideogram4Transformer]:
        """Put both transformer branches on the device and keep them there for the whole loop.

        A diffusers pipeline yields both in one cache entity (`Ideogram4TransformerPair`); single
        files are two models and are locked simultaneously, because every step runs both and
        releasing one between steps would make the cache stream it back for the next.

        Both locks get the *same* reservation even though the dequantization transient is per branch
        and the two branches can be different builds. The cache computes free VRAM as
        `capacity - working_mem - in_use` at each lock, and the second lock cannot claw space back
        from the first, which is already locked: a first branch that reserved less has taken
        headroom the second one still needs, and with the second branch already resident from an
        earlier run there is nothing left to evict.

        Taking the maximum up front costs reading `LoadedModel.model` -- documented as returning the
        model unlocked, and it is already constructed by then -- and loading the second branch into
        RAM before the first is locked. Under the default `keep_ram_copy_of_weights` that is not a
        new peak, since both branches hold their RAM copies through the loop anyway; with RAM copies
        off it is one cold load's worth, which the cache absorbs the same way it absorbs any
        overshoot. Neither branch can be evicted meanwhile: `LoadedModel` takes a first-use hold the
        moment it is constructed, and `make_room` skips a record that has one.
        """
        conditional_info = context.models.load(self.transformer.transformer)
        both_in_one = isinstance(conditional_info.model, Ideogram4TransformerPair)

        # Checked before the second model is loaded, so a mis-wired graph costs an error rather than
        # a ~9 GiB read. Real checks, not asserts: a hand-built graph can wire anything here, and
        # under `python -O` an assert would vanish and leave the mismatch to surface inside the loop.
        if both_in_one and self.unconditional_transformer is not None:
            raise ValueError(
                "'Transformer' already carries both Ideogram 4 branches, so 'Transformer (Unconditional)' "
                "must not be connected. Disconnect it, or select a single-file checkpoint as the model."
            )
        if not both_in_one and self.unconditional_transformer is None:
            raise ValueError(
                "This Ideogram 4 transformer holds only one branch, so 'Transformer (Unconditional)' "
                "must be connected as well. The Ideogram 4 model loader emits it when the model is a "
                "single-file checkpoint."
            )

        second = self.unconditional_transformer
        unconditional_info = None if second is None else context.models.load(second.transformer)
        reservation = working_mem_bytes + max(
            self._dequant_transient(conditional_info.model),
            0 if unconditional_info is None else self._dequant_transient(unconditional_info.model),
        )

        primary = stack.enter_context(conditional_info.model_on_device(working_mem_bytes=reservation))[1]
        if unconditional_info is None:
            # Narrowing, not validation: `both_in_one` was decided from this same object above, and
            # locking it does not change what it is. The user-facing refusals are the two checks
            # further up, which is why they are `raise` and this is not.
            assert isinstance(primary, Ideogram4TransformerPair)
            return primary.conditional, primary.unconditional

        unconditional = stack.enter_context(unconditional_info.model_on_device(working_mem_bytes=reservation))[1]
        for role, branch in (("Transformer", primary), ("Transformer (Unconditional)", unconditional)):
            if not isinstance(branch, Ideogram4Transformer):
                raise ValueError(
                    f"'{role}' is a {type(branch).__name__}, not an Ideogram 4 transformer. Both inputs "
                    "must come from the Ideogram 4 model loader."
                )
        return primary, unconditional
