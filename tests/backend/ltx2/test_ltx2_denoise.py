"""The LTX-2 denoising loop, over a transformer stub that records what it was asked."""

from types import SimpleNamespace

import pytest
import torch

from invokeai.app.services.session_processor.session_processor_common import CanceledException
from invokeai.backend.ltx2.constants import LTX2_LATENT_CHANNELS
from invokeai.backend.ltx2.denoise import build_denoise_state, denoise, preview_latent_frame
from invokeai.backend.ltx2.guidance import LTX2Guidance
from invokeai.backend.ltx2.packing import pack_video_latents, unpack_video_latents
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import LTX2ConditioningInfo

WIDTH, HEIGHT, FRAMES = 64, 64, 9
LATENT = (2, 2, 2)  # frames, height, width at 32x/8x compression
ROWS = LATENT[0] * LATENT[1] * LATENT[2]
OFF = {"cfg_scale": 1.0, "audio_cfg_scale": 1.0, "stg_scale": 0.0, "modality_scale": 1.0, "rescale": 0.0}


def _conditioning(seed: int) -> LTX2ConditioningInfo:
    generator = torch.Generator().manual_seed(seed)
    return LTX2ConditioningInfo(
        video_embeds=torch.randn(1, 4, 8, generator=generator),
        audio_embeds=torch.randn(1, 4, 6, generator=generator),
        attention_mask=torch.ones(1, 4, dtype=torch.int64),
    )


class TransformerStub(torch.nn.Module):
    """Returns a velocity that denoises toward a fixed target, and records every call."""

    def __init__(self, target: torch.Tensor | None = None) -> None:
        super().__init__()
        self.config = SimpleNamespace(timestep_scale_multiplier=1000, patch_size=1, patch_size_t=1)
        self.rope = SimpleNamespace(
            prepare_video_coords=lambda b, f, h, w, device, fps: torch.zeros(b, 3, f * h * w, 2, device=device)
        )
        self.audio_rope = SimpleNamespace(
            prepare_audio_coords=lambda b, n, device: torch.zeros(b, 1, n, 2, device=device)
        )
        self.transformer_blocks = torch.nn.ModuleList([torch.nn.Identity()])
        self.calls: list[dict] = []
        self.target = target

    def forward(self, **kwargs):
        # Run the block the cancel hook is attached to, the way the real forward does.
        self.transformer_blocks[0](kwargs["hidden_states"])
        self.calls.append(kwargs)
        video, audio = kwargs["hidden_states"].float(), kwargs["audio_hidden_states"].float()
        if self.target is None:
            return torch.zeros_like(video), torch.zeros_like(audio)
        # x0 = x - sigma * v, so this velocity predicts `target` at any sigma.
        sigma = float(kwargs["sigma"][0]) / 1000.0
        return (video - self.target) / max(sigma, 1e-6), torch.zeros_like(audio)


def _denoise(transformer, state, guidance, negative=None, **kwargs):
    return denoise(
        transformer=transformer,
        state=state,
        positive=_conditioning(1),
        negative=negative,
        guidance=guidance,
        fps=24.0,
        dtype=torch.float32,
        device=torch.device("cpu"),
        **kwargs,
    )


def _state(**kwargs):
    return build_denoise_state(
        num_frames=FRAMES, height=HEIGHT, width=WIDTH, fps=24.0, seed=7, distilled=False, num_steps=3, **kwargs
    )


def test_every_pass_runs_once_per_step_with_its_own_conditioning_and_flags() -> None:
    transformer = TransformerStub()
    guidance = LTX2Guidance(cfg_scale=3.0, audio_cfg_scale=7.0, stg_scale=1.0, modality_scale=3.0, rescale=0.0)
    negative = _conditioning(2)

    _denoise(transformer, _state(), guidance, negative=negative)

    assert len(transformer.calls) == 3 * 4
    first_step = transformer.calls[:4]
    assert [call["spatio_temporal_guidance_blocks"] for call in first_step] == [None, None, [28], None]
    assert [call["isolate_modalities"] for call in first_step] == [False, False, False, True]
    # Only the unconditional pass sees the negative prompt.
    assert torch.equal(first_step[1]["encoder_hidden_states"], negative.video_embeds)
    for index in (0, 2, 3):
        assert torch.equal(first_step[index]["encoder_hidden_states"], _conditioning(1).video_embeds)


def test_an_unguided_run_costs_one_forward_per_step() -> None:
    transformer = TransformerStub()
    _denoise(transformer, _state(), LTX2Guidance(**OFF))
    assert len(transformer.calls) == 3


def test_classifier_free_guidance_without_negative_conditioning_is_refused() -> None:
    with pytest.raises(ValueError, match="negative conditioning"):
        _denoise(TransformerStub(), _state(), LTX2Guidance())


def test_the_timestep_is_the_sigma_on_the_transformers_own_scale() -> None:
    transformer = TransformerStub()
    state = _state()
    _denoise(transformer, state, LTX2Guidance(**OFF))

    for index, call in enumerate(transformer.calls):
        assert float(call["timestep"][0]) == pytest.approx(float(state.sigmas[index]) * 1000)
        assert torch.equal(call["timestep"], call["audio_timestep"])
        assert torch.equal(call["timestep"], call["sigma"])


def test_a_conditioned_token_is_presented_as_clean_and_never_drifts() -> None:
    """The one mechanism behind every kind of conditioning: the anchor's timestep is zero at every
    forward, and its value is the encode it came from at the end of the run."""
    image_latents = torch.randn(1, LTX2_LATENT_CHANNELS, 1, LATENT[1], LATENT[2])
    state = _state(image_latents=image_latents)
    transformer = TransformerStub(target=torch.randn(1, ROWS, LTX2_LATENT_CHANNELS))

    video, _ = _denoise(transformer, state, LTX2Guidance(**OFF))

    anchor_rows = LATENT[1] * LATENT[2]
    for call in transformer.calls:
        assert call["timestep"].shape == (1, ROWS)
        assert torch.equal(call["timestep"][0, :anchor_rows], torch.zeros(anchor_rows))
        assert (call["timestep"][0, anchor_rows:] > 0).all()

    unpacked = unpack_video_latents(video, *LATENT)
    assert torch.allclose(unpacked[:, :, :1], image_latents, atol=1e-5)


def test_a_partial_conditioning_strength_holds_the_anchor_partway() -> None:
    image_latents = torch.randn(1, LTX2_LATENT_CHANNELS, 1, LATENT[1], LATENT[2])
    state = _state(image_latents=image_latents, conditioning_strength=0.5)
    transformer = TransformerStub(target=torch.randn(1, ROWS, LTX2_LATENT_CHANNELS))

    video, _ = _denoise(transformer, state, LTX2Guidance(**OFF))

    anchor_rows = LATENT[1] * LATENT[2]
    half = float(state.sigmas[0]) * 1000 * 0.5
    assert transformer.calls[0]["timestep"][0, :anchor_rows].tolist() == pytest.approx([half] * anchor_rows)
    assert not torch.allclose(unpack_video_latents(video, *LATENT)[:, :, :1], image_latents, atol=1e-3)


@pytest.mark.parametrize("strength", [0.0, -0.5, 1.5])
def test_a_conditioning_strength_outside_the_unit_interval_is_refused(strength: float) -> None:
    with pytest.raises(ValueError, match="strength"):
        _state(
            image_latents=torch.randn(1, LTX2_LATENT_CHANNELS, 1, LATENT[1], LATENT[2]), conditioning_strength=strength
        )


def test_an_image_conditioning_encoded_for_another_canvas_is_refused() -> None:
    with pytest.raises(ValueError, match="needs"):
        _state(image_latents=torch.randn(1, LTX2_LATENT_CHANNELS, 1, 4, 4))


def test_the_ancestral_branch_renoises_and_puts_the_anchor_back() -> None:
    """The distilled schedule injects noise at every step; without the restore the anchor would be
    noised along with everything else."""
    image_latents = torch.randn(1, LTX2_LATENT_CHANNELS, 1, LATENT[1], LATENT[2])
    state = build_denoise_state(
        num_frames=FRAMES,
        height=HEIGHT,
        width=WIDTH,
        fps=24.0,
        seed=7,
        distilled=True,
        num_steps=8,
        image_latents=image_latents,
    )
    assert state.eta == 1.0

    video, _ = _denoise(TransformerStub(target=torch.randn(1, ROWS, LTX2_LATENT_CHANNELS)), state, LTX2Guidance(**OFF))
    assert torch.allclose(unpack_video_latents(video, *LATENT)[:, :, :1], image_latents, atol=1e-5)


def test_a_cancel_stops_the_run_inside_a_forward() -> None:
    """A step is a whole transformer forward, so a cancel polled between steps would leave the GPU
    busy for the rest of it; the hook fires per block instead."""
    transformer = TransformerStub()
    with pytest.raises(CanceledException):
        _denoise(transformer, _state(), LTX2Guidance(**OFF), is_canceled=lambda: True)
    assert transformer.calls == []


def test_the_preview_frame_is_the_middle_frame_of_the_unpacked_clip() -> None:
    """The preview slices the packed rows instead of unpacking the clip, which is only valid
    because the rows are frame-major; the expectation is the unpacked tensor it replaces."""
    latents = torch.randn(1, LTX2_LATENT_CHANNELS, 5, 3, 4)
    state = build_denoise_state(num_frames=33, height=96, width=128, fps=24.0, seed=1, distilled=False, num_steps=1)
    packed = pack_video_latents(latents)

    assert (state.latent_frames, state.latent_height, state.latent_width) == (5, 3, 4)
    assert torch.equal(preview_latent_frame(packed, state), latents[:, :, 2])


def test_the_step_callback_reports_progress_and_a_previewable_frame() -> None:
    reported: list[tuple[int, int, tuple[int, ...]]] = []
    state = _state()

    def callback(step: int, total: int, video_x0: torch.Tensor) -> None:
        reported.append((step, total, tuple(preview_latent_frame(video_x0, state).shape)))

    _denoise(TransformerStub(), state, LTX2Guidance(**OFF), step_callback=callback)
    assert reported == [(i, 3, (1, LTX2_LATENT_CHANNELS, LATENT[1], LATENT[2])) for i in (1, 2, 3)]


def test_the_run_is_reproducible_from_its_seed_and_differs_without_it() -> None:
    same = [_denoise(TransformerStub(), _state(), LTX2Guidance(**OFF))[0] for _ in range(2)]
    assert torch.equal(*same)

    other = build_denoise_state(
        num_frames=FRAMES, height=HEIGHT, width=WIDTH, fps=24.0, seed=8, distilled=False, num_steps=3
    )
    assert not torch.equal(_denoise(TransformerStub(), other, LTX2Guidance(**OFF))[0], same[0])
