"""The LTX-2 denoising loop.

One transformer forward produces both modalities' velocity predictions, so a guidance pass is a
pass for video *and* audio; the two are combined separately afterwards (see
:mod:`invokeai.backend.ltx2.guidance`) and stepped down the same sigma schedule.

Conditioning -- a first frame or a whole held modality today, keyframes later -- is carried by one
mechanism: a per-token mask over the packed video sequence. A conditioned token's timestep is
forced to 0 for every forward, and its value is restored from the clean latents after every step,
so the anchor neither drifts nor gets renoised by the ancestral sampler.
"""

from collections.abc import Callable
from dataclasses import dataclass

import torch
from diffusers.utils.torch_utils import randn_tensor

from invokeai.backend.ltx2.constants import (
    LTX2_ANCESTRAL_ETA,
    LTX2_ANCESTRAL_NOISE_SEED_OFFSET,
    LTX2_ANCESTRAL_S_NOISE,
    LTX2_AUDIO_LATENT_CHANNELS,
    LTX2_AUDIO_LATENT_MEL_BINS,
    LTX2_LATENT_CHANNELS,
    LTX2_REFINE_NOISE_SEED_OFFSET,
)
from invokeai.backend.ltx2.guidance import (
    PASS_MODALITY,
    PASS_STG,
    PASS_UNCOND,
    LTX2Guidance,
    LTX2GuidancePass,
)
from invokeai.backend.ltx2.packing import (
    audio_latent_count,
    pack_audio_latents,
    pack_video_latents,
    validate_canvas,
    validate_num_frames,
    video_latent_shape,
    video_sequence_length,
)
from invokeai.backend.ltx2.sampling import build_refine_sigmas, build_sigmas, flow_step
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import LTX2ConditioningInfo
from invokeai.backend.util.cancel_hooks import cancel_before_forward


@dataclass
class LTX2DenoiseState:
    """Everything a denoise run needs that does not come from the models, built on the CPU."""

    video_latents: torch.Tensor
    """Packed, normalized, noised video latents. Shape: (1, video tokens, 128)."""

    audio_latents: torch.Tensor
    """Packed, normalized, noised audio latents. Shape: (1, audio latents, 128)."""

    sigmas: torch.Tensor
    """The noise levels to sample, terminal 0 included. Shape: (steps + 1,)."""

    latent_frames: int
    latent_height: int
    latent_width: int
    audio_latents_count: int

    conditioning_mask: torch.Tensor | None
    """How strongly each video token is held to its conditioning, 0 (free) to 1 (clean).

    Shape: (1, video tokens). A token's timestep is scaled by ``1 - mask`` and its x0 prediction is
    blended toward the clean value by ``mask``, so a fractional mask is a partial anchor rather
    than a switch.
    """

    clean_video_latents: torch.Tensor | None
    """The conditioned tokens' clean values, at full packed shape (0 elsewhere)."""

    eta: float
    noise_seed: int

    audio_conditioning_mask: torch.Tensor | None = None
    """How strongly each audio row is held to its conditioning, 0 (free) to 1 (clean).

    Shape: (1, audio latents). The mirror of ``conditioning_mask`` on the other modality: LTX-2
    conditions both streams through one mechanism, so audio-to-video is an all-ones mask here and
    video-to-audio is an all-ones mask on the video side.
    """

    clean_audio_latents: torch.Tensor | None = None
    """Packed, normalized audio latents the mask holds rows to. Shape: (1, audio latents, 128)."""

    @property
    def num_steps(self) -> int:
        return self.sigmas.numel() - 1


def build_denoise_state(
    *,
    num_frames: int,
    height: int,
    width: int,
    fps: float,
    seed: int,
    distilled: bool,
    num_steps: int,
    image_latents: torch.Tensor | None = None,
    conditioning_strength: float = 1.0,
    frozen_audio_latents: torch.Tensor | None = None,
    frozen_video_latents: torch.Tensor | None = None,
) -> LTX2DenoiseState:
    """Noise, schedule and conditioning mask for one run.

    ``image_latents`` is a clean, normalized ``(1, 128, 1, h, w)`` encode of the first frame; when
    given it becomes latent frame 0, held to ``conditioning_strength``. Noise is drawn on the CPU
    (video first, then audio) so a request is reproducible across devices.

    ``frozen_audio_latents`` and ``frozen_video_latents`` hold a whole modality clean instead: the
    first is audio-to-video, the second video-to-audio. They are the same mask mechanism as the
    first frame, with every row set rather than one -- which is why the two modes need no machinery
    of their own beyond an encode. Giving both would leave nothing to sample, so it is refused.
    """
    if frozen_audio_latents is not None and frozen_video_latents is not None:
        raise ValueError(
            "Audio and video cannot both be held: that would leave nothing for the model to generate. "
            "Condition on one modality or the other."
        )
    # A held clip already covers frame 0, so the first-frame encode would be overwritten rather
    # than combined -- two different pictures asked for in the same rows. Holding a soundtrack
    # alongside a first frame is a different matter and stays allowed: those are separate streams.
    if frozen_video_latents is not None and image_latents is not None:
        raise ValueError(
            "A first frame cannot be combined with a whole-clip video conditioning: the clip already "
            "supplies frame 0. Wire one or the other."
        )
    validate_canvas(height, width)
    validate_num_frames(num_frames)

    latent_frames, latent_height, latent_width = video_latent_shape(num_frames, height, width)
    audio_count = audio_latent_count(num_frames, fps)
    if audio_count < 1:
        raise ValueError(
            f"A {num_frames}-frame clip at {fps} fps is shorter than one audio latent "
            f"({1 / 25:.2f} s); generate a longer clip."
        )

    generator = torch.Generator(device="cpu").manual_seed(seed)
    video_noise = randn_tensor(
        (1, LTX2_LATENT_CHANNELS, latent_frames, latent_height, latent_width),
        generator=generator,
        device=torch.device("cpu"),
        dtype=torch.float32,
    )
    audio_noise = randn_tensor(
        (1, LTX2_AUDIO_LATENT_CHANNELS, audio_count, LTX2_AUDIO_LATENT_MEL_BINS),
        generator=generator,
        device=torch.device("cpu"),
        dtype=torch.float32,
    )

    video_latents = pack_video_latents(video_noise)
    conditioning_mask: torch.Tensor | None = None
    clean_video_latents: torch.Tensor | None = None

    if image_latents is not None:
        expected = (1, LTX2_LATENT_CHANNELS, 1, latent_height, latent_width)
        if tuple(image_latents.shape) != expected:
            raise ValueError(
                f"The image conditioning was encoded at {tuple(image_latents.shape)} but this "
                f"generation needs {expected}. Re-run the conditioning node at {width}x{height}."
            )
        clean = torch.zeros_like(video_noise)
        clean[:, :, 0] = image_latents.to(device="cpu", dtype=torch.float32)[:, :, 0]
        if not 0.0 < conditioning_strength <= 1.0:
            raise ValueError(f"Image conditioning strength must be in (0, 1]; got {conditioning_strength}.")
        mask = torch.zeros((1, 1, latent_frames, latent_height, latent_width), dtype=torch.float32)
        mask[:, :, 0] = conditioning_strength

        clean_video_latents = pack_video_latents(clean)
        conditioning_mask = pack_video_latents(mask).squeeze(-1)
        video_latents = torch.lerp(video_latents, clean_video_latents, conditioning_mask.unsqueeze(-1))

    audio_latents = pack_audio_latents(audio_noise)
    audio_conditioning_mask: torch.Tensor | None = None
    clean_audio_latents: torch.Tensor | None = None

    if frozen_audio_latents is not None:
        expected_audio = (1, audio_count, LTX2_AUDIO_LATENT_CHANNELS * LTX2_AUDIO_LATENT_MEL_BINS)
        if tuple(frozen_audio_latents.shape) != expected_audio:
            raise ValueError(
                f"The conditioning soundtrack is {tuple(frozen_audio_latents.shape)} but a "
                f"{num_frames}-frame clip at {fps:g} fps needs {expected_audio}. Derive the frame "
                f"count from the soundtrack rather than setting it separately."
            )
        clean_audio_latents = frozen_audio_latents.to(device="cpu", dtype=torch.float32)
        audio_conditioning_mask = torch.ones((1, audio_count), dtype=torch.float32)
        audio_latents = clean_audio_latents.clone()

    if frozen_video_latents is not None:
        expected_video = (1, LTX2_LATENT_CHANNELS, latent_frames, latent_height, latent_width)
        if tuple(frozen_video_latents.shape) != expected_video:
            raise ValueError(
                f"The conditioning clip is {tuple(frozen_video_latents.shape)} but {width}x{height} "
                f"at {num_frames} frames needs {expected_video}."
            )
        clean_video_latents = pack_video_latents(frozen_video_latents.to(device="cpu", dtype=torch.float32))
        conditioning_mask = torch.ones((1, clean_video_latents.shape[1]), dtype=torch.float32)
        video_latents = clean_video_latents.clone()

    return LTX2DenoiseState(
        video_latents=video_latents,
        audio_latents=audio_latents,
        sigmas=build_sigmas(
            distilled=distilled,
            num_steps=num_steps,
            video_seq_len=video_sequence_length(num_frames, height, width),
        ),
        latent_frames=latent_frames,
        latent_height=latent_height,
        latent_width=latent_width,
        audio_latents_count=audio_count,
        conditioning_mask=conditioning_mask,
        clean_video_latents=clean_video_latents,
        audio_conditioning_mask=audio_conditioning_mask,
        clean_audio_latents=clean_audio_latents,
        # LTX-2.5 samples its distilled schedule ancestrally and its shifted schedule
        # deterministically; eta is what selects between the two branches of one step.
        eta=LTX2_ANCESTRAL_ETA if distilled else 0.0,
        noise_seed=seed + LTX2_ANCESTRAL_NOISE_SEED_OFFSET,
    )


def build_refine_state(
    *,
    video_latents: torch.Tensor,
    audio_latents: torch.Tensor,
    num_frames: int,
    height: int,
    width: int,
    fps: float,
    seed: int,
    distilled: bool,
    num_steps: int,
    noise_scale: float,
    image_latents: torch.Tensor | None = None,
    conditioning_strength: float = 1.0,
) -> LTX2DenoiseState:
    """The refine pass's state: stage one's result re-entered partway down the schedule.

    ``video_latents`` is the upsampled ``(1, 128, T, h, w)`` clip at the *second* stage's canvas,
    normalized; ``audio_latents`` is stage one's packed audio, which no upsampler touches. Both are
    noised back to the level the schedule is re-entered at -- ``x = (1 - sigma) * x0 + sigma * eps``,
    the forward process of the same rectified flow the step inverts -- because a partial schedule
    expects a sample at its first level, not a clean one.

    Audio is re-noised to the same level rather than carried through clean: the two modalities are
    denoised jointly and the transformer reads one pair of timesteps, so handing it clean audio
    beside a noised video would place the two streams at different points of the same trajectory.

    ``image_latents`` re-anchors a conditioned first frame, and has to be a *fresh* encode at this
    pass's canvas -- stage one's is half the size. Re-anchoring is not optional for image-to-video:
    the refine pass re-noises every token, frame 0 included, so at the released entry level about
    nine tenths of the anchored frame's signal is replaced by noise and nothing restores it. Without
    this the first frame would be regenerated from the prompt alone, and a two-stage run would
    quietly mean something different by "first frame" than a single-stage one.
    """
    validate_canvas(height, width)
    validate_num_frames(num_frames)

    latent_frames, latent_height, latent_width = video_latent_shape(num_frames, height, width)
    expected = (1, LTX2_LATENT_CHANNELS, latent_frames, latent_height, latent_width)
    if tuple(video_latents.shape) != expected:
        raise ValueError(
            f"The refine pass was handed {tuple(video_latents.shape)} latents but {width}x{height} "
            f"at {num_frames} frames needs {expected}. Check the upsampler's scale against the "
            f"canvas the stages were planned at."
        )

    audio_count = audio_latent_count(num_frames, fps)
    # The packed audio row is one channel-by-mel-bin block, which happens to be the same width as a
    # video row; asserting the video channel count here would be the right number for the wrong
    # reason, and would stop being right the day either shape moved.
    audio_row = LTX2_AUDIO_LATENT_CHANNELS * LTX2_AUDIO_LATENT_MEL_BINS
    if tuple(audio_latents.shape) != (1, audio_count, audio_row):
        raise ValueError(
            f"The refine pass was handed {tuple(audio_latents.shape)} audio latents but this clip "
            f"needs {(1, audio_count, audio_row)}; both stages must run at one fps and frame count."
        )

    sigmas = build_refine_sigmas(
        distilled=distilled,
        refine_steps=num_steps,
        video_seq_len=video_sequence_length(num_frames, height, width),
        noise_scale=noise_scale,
    )
    sigma = sigmas[0].to(torch.float32)

    # Drawn on the CPU, so a refine is reproducible across devices, and offset from the base pass's
    # stream so the noise mixed back in is not the noise the clip was grown out of.
    generator = torch.Generator(device="cpu").manual_seed(seed + LTX2_REFINE_NOISE_SEED_OFFSET)
    packed_video = pack_video_latents(video_latents.to(device="cpu", dtype=torch.float32))
    audio = audio_latents.to(device="cpu", dtype=torch.float32)
    video_noise = randn_tensor(packed_video.shape, generator=generator, device=torch.device("cpu"), dtype=torch.float32)
    audio_noise = randn_tensor(audio.shape, generator=generator, device=torch.device("cpu"), dtype=torch.float32)

    video_latents = torch.lerp(packed_video, video_noise, sigma)
    conditioning_mask: torch.Tensor | None = None
    clean_video_latents: torch.Tensor | None = None

    if image_latents is not None:
        expected_anchor = (1, LTX2_LATENT_CHANNELS, 1, latent_height, latent_width)
        if tuple(image_latents.shape) != expected_anchor:
            raise ValueError(
                f"The refine pass's image conditioning was encoded at {tuple(image_latents.shape)} "
                f"but this pass needs {expected_anchor}. Encode it at the refine canvas "
                f"({width}x{height}), not the base pass's."
            )
        if not 0.0 < conditioning_strength <= 1.0:
            raise ValueError(f"Image conditioning strength must be in (0, 1]; got {conditioning_strength}.")

        clean = torch.zeros((1, LTX2_LATENT_CHANNELS, latent_frames, latent_height, latent_width))
        clean[:, :, 0] = image_latents.to(device="cpu", dtype=torch.float32)[:, :, 0]
        mask = torch.zeros((1, 1, latent_frames, latent_height, latent_width), dtype=torch.float32)
        mask[:, :, 0] = conditioning_strength

        clean_video_latents = pack_video_latents(clean)
        conditioning_mask = pack_video_latents(mask).squeeze(-1)
        video_latents = torch.lerp(video_latents, clean_video_latents, conditioning_mask.unsqueeze(-1))

    return LTX2DenoiseState(
        video_latents=video_latents,
        audio_latents=torch.lerp(audio, audio_noise, sigma),
        sigmas=sigmas,
        latent_frames=latent_frames,
        latent_height=latent_height,
        latent_width=latent_width,
        audio_latents_count=audio_count,
        conditioning_mask=conditioning_mask,
        clean_video_latents=clean_video_latents,
        eta=LTX2_ANCESTRAL_ETA if distilled else 0.0,
        noise_seed=seed + LTX2_REFINE_NOISE_SEED_OFFSET + LTX2_ANCESTRAL_NOISE_SEED_OFFSET,
    )


@torch.no_grad()
def denoise(
    *,
    transformer: torch.nn.Module,
    state: LTX2DenoiseState,
    positive: LTX2ConditioningInfo,
    negative: LTX2ConditioningInfo | None,
    guidance: LTX2Guidance,
    fps: float,
    dtype: torch.dtype,
    device: torch.device,
    step_callback: Callable[[int, int, torch.Tensor], None] | None = None,
    is_canceled: Callable[[], bool] | None = None,
) -> tuple[torch.Tensor, torch.Tensor]:
    """Run the schedule and return the final packed, normalized ``(video, audio)`` latents."""
    passes = guidance.passes
    if PASS_UNCOND in passes and negative is None:
        raise ValueError("Classifier-free guidance needs negative conditioning, but none was provided.")

    video_latents = state.video_latents.to(device=device, dtype=torch.float32)
    audio_latents = state.audio_latents.to(device=device, dtype=torch.float32)
    sigmas = state.sigmas.to(device=device)

    conditioning_mask = clean_video_latents = None
    if state.conditioning_mask is not None:
        assert state.clean_video_latents is not None
        conditioning_mask = state.conditioning_mask.to(device=device, dtype=torch.float32)
        clean_video_latents = state.clean_video_latents.to(device=device, dtype=torch.float32)

    audio_mask = clean_audio_latents = None
    if state.audio_conditioning_mask is not None:
        assert state.clean_audio_latents is not None
        audio_mask = state.audio_conditioning_mask.to(device=device, dtype=torch.float32)
        clean_audio_latents = state.clean_audio_latents.to(device=device, dtype=torch.float32)

    # Three of the four passes read the *same* conditioning and differ only in their model flags,
    # so the device copies are made once per distinct conditioning rather than once per pass.
    positive_encoders = _encoder_inputs(positive, device=device, dtype=dtype)
    negative_encoders = (
        _encoder_inputs(negative, device=device, dtype=dtype) if PASS_UNCOND in passes and negative else None
    )
    encoders = {name: negative_encoders if name == PASS_UNCOND else positive_encoders for name in passes}

    # The RoPE coordinates are the audio/video alignment: both are expressed in seconds, so the
    # video grid has to be built at the clip's real frame rate.
    video_coords = transformer.rope.prepare_video_coords(
        1, state.latent_frames, state.latent_height, state.latent_width, device, fps=fps
    )
    audio_coords = transformer.audio_rope.prepare_audio_coords(1, state.audio_latents_count, device)

    timestep_scale = float(transformer.config.timestep_scale_multiplier)
    stg_blocks = list(guidance.stg_blocks)
    noise_generator = torch.Generator(device="cpu").manual_seed(state.noise_seed)
    total_steps = state.num_steps

    with cancel_before_forward(transformer.transformer_blocks, is_canceled, device):
        for index in range(total_steps):
            sigma = sigmas[index]
            timestep = (sigma * timestep_scale).expand(1)
            # A conditioned token is presented as fully denoised; `sigma`/`audio_sigma` stay the
            # plain step value, which is what the prompt-AdaLN and the cross-modality gates read.
            video_timestep = timestep if conditioning_mask is None else timestep.unsqueeze(-1) * (1 - conditioning_mask)
            audio_timestep = timestep if audio_mask is None else timestep.unsqueeze(-1) * (1 - audio_mask)

            video_input = video_latents.to(dtype)
            audio_input = audio_latents.to(dtype)
            video_predictions: dict[LTX2GuidancePass, torch.Tensor] = {}
            audio_predictions: dict[LTX2GuidancePass, torch.Tensor] = {}
            for name in passes:
                video_velocity, audio_velocity = transformer(
                    hidden_states=video_input,
                    audio_hidden_states=audio_input,
                    timestep=video_timestep,
                    audio_timestep=audio_timestep,
                    sigma=timestep,
                    num_frames=state.latent_frames,
                    height=state.latent_height,
                    width=state.latent_width,
                    fps=fps,
                    audio_num_frames=state.audio_latents_count,
                    video_coords=video_coords,
                    audio_coords=audio_coords,
                    isolate_modalities=name == PASS_MODALITY,
                    spatio_temporal_guidance_blocks=stg_blocks if name == PASS_STG else None,
                    use_cross_timestep=True,
                    return_dict=False,
                    **encoders[name],
                )
                # x0 = x - sigma * v, the space the guidance deltas and the step are written in,
                # at the step's own scalar sigma. A partially held token was shown a smaller
                # timestep than that, so its x0 is an approximation -- the same one the reference
                # condition path makes (`LTX2ConditionLoopAfterDenoiser` converts with the
                # scheduler's scalar sigma too), and the mask blend below corrects it.
                video_predictions[name] = video_latents - video_velocity.float() * sigma
                audio_predictions[name] = audio_latents - audio_velocity.float() * sigma

            video_x0 = guidance.combine_video(video_predictions)
            audio_x0 = guidance.combine_audio(audio_predictions)
            if conditioning_mask is not None:
                video_x0 = torch.lerp(video_x0, clean_video_latents, conditioning_mask.unsqueeze(-1))
            if audio_mask is not None:
                audio_x0 = torch.lerp(audio_x0, clean_audio_latents, audio_mask.unsqueeze(-1))

            if step_callback is not None:
                step_callback(index + 1, total_steps, video_x0)

            video_noise, audio_noise = _step_noise(state, video_latents, audio_latents, noise_generator, device)
            step = {"eta": state.eta, "s_noise": LTX2_ANCESTRAL_S_NOISE}
            video_latents = flow_step(video_latents, video_x0, sigmas, index, noise=video_noise, **step)
            audio_latents = flow_step(audio_latents, audio_x0, sigmas, index, noise=audio_noise, **step)
            if conditioning_mask is not None and state.eta > 0:
                # The ancestral branch renoises every token, anchors included, so they are put back.
                # The deterministic branch needs no restore: a step is a convex combination of the
                # token's own value and its (already blended) prediction, which for a fully clean
                # anchor is the anchor, and for a partial one is the interpolation the mask asks for.
                video_latents = torch.lerp(video_latents, clean_video_latents, conditioning_mask.unsqueeze(-1))
            if audio_mask is not None and state.eta > 0:
                audio_latents = torch.lerp(audio_latents, clean_audio_latents, audio_mask.unsqueeze(-1))

    return video_latents, audio_latents


def _encoder_inputs(
    conditioning: LTX2ConditioningInfo, *, device: torch.device, dtype: torch.dtype
) -> dict[str, torch.Tensor]:
    return {
        "encoder_hidden_states": conditioning.video_embeds.to(device=device, dtype=dtype),
        "audio_encoder_hidden_states": conditioning.audio_embeds.to(device=device, dtype=dtype),
        "encoder_attention_mask": conditioning.attention_mask.to(device=device),
        "audio_encoder_attention_mask": conditioning.attention_mask.to(device=device),
    }


def _step_noise(
    state: LTX2DenoiseState,
    video_latents: torch.Tensor,
    audio_latents: torch.Tensor,
    generator: torch.Generator,
    device: torch.device,
) -> tuple[torch.Tensor | None, torch.Tensor | None]:
    """The ancestral step's re-injected noise, drawn video-first from one CPU generator."""
    if state.eta <= 0:
        return None, None
    video_noise = randn_tensor(
        video_latents.shape, generator=generator, device=torch.device("cpu"), dtype=torch.float32
    )
    audio_noise = randn_tensor(
        audio_latents.shape, generator=generator, device=torch.device("cpu"), dtype=torch.float32
    )
    return video_noise.to(device), audio_noise.to(device)


def preview_latent_frame(packed: torch.Tensor, state: LTX2DenoiseState) -> torch.Tensor:
    """The middle latent frame of a packed video tensor, as ``(1, 128, h, w)`` for the previewer.

    Sliced out of the packed rows rather than unpacked whole: the rows are frame-major, so one
    frame is one contiguous span, and unpacking the clip to keep a sixteenth of it would copy the
    whole thing once per step.
    """
    rows_per_frame = state.latent_height * state.latent_width
    start = (state.latent_frames // 2) * rows_per_frame
    frame = packed[:, start : start + rows_per_frame]

    return frame.transpose(1, 2).reshape(packed.shape[0], -1, state.latent_height, state.latent_width)
