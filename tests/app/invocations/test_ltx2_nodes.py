"""LTX-2 node contracts that do not need a model: what each node refuses, and why."""

import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import numpy as np
import pytest
import torch
from PIL import Image

import invokeai.app.invocations.ltx2.ltx2_audio_conditioning as ltx2_audio_conditioning
import invokeai.app.invocations.ltx2.ltx2_video_conditioning as ltx2_video_conditioning
import invokeai.app.invocations.vae.ltx2_latents_to_video as ltx2_latents_to_video
from invokeai.app.invocations.fields import (
    LatentsField,
    LTX2AudioConditioningField,
    LTX2ConditioningField,
    LTX2FullVideoConditioningField,
    LTX2VideoConditioningField,
    VideoField,
)
from invokeai.app.invocations.ltx2.ltx2_audio_conditioning import LTX2AudioConditioningInvocation
from invokeai.app.invocations.ltx2.ltx2_denoise import LTX2DenoiseInvocation
from invokeai.app.invocations.ltx2.ltx2_ideal_dimensions import LTX2IdealDimensionsInvocation
from invokeai.app.invocations.ltx2.ltx2_latent_upsample import LTX2LatentUpsampleInvocation
from invokeai.app.invocations.ltx2.ltx2_model_loader import LTX2ModelLoaderInvocation
from invokeai.app.invocations.ltx2.ltx2_video_conditioning import LTX2VideoConditioningInvocation
from invokeai.app.invocations.model import (
    LTX2LatentUpsamplerField,
    LTX2TransformerField,
    LTX2VocoderField,
    ModelIdentifierField,
    VAEField,
)
from invokeai.app.invocations.vae.ltx2_latents_to_video import LTX2LatentsToVideoInvocation
from invokeai.backend.ltx2.constants import (
    LTX2_AUDIO_LATENT_CHANNELS,
    LTX2_AUDIO_LATENT_MEL_BINS,
    LTX2_LATENT_CHANNELS,
)
from invokeai.backend.ltx2.denoise import build_denoise_state
from invokeai.backend.ltx2.image_conditioning import fit_to_canvas, recompress_h264
from invokeai.backend.ltx2.packing import audio_latent_count, latent_frame_count, validate_num_frames
from invokeai.backend.model_manager.configs.main import Main_Diffusers_LTX2_Config
from invokeai.backend.model_manager.taxonomy import BaseModelType, LTX2VariantType, ModelFormat, ModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import LTX2ConditioningInfo
from invokeai.backend.util.devices import TorchDevice


def _identifier(key: str = "transformer") -> ModelIdentifierField:
    return ModelIdentifierField(
        key=key, hash="hash", name=key, base=BaseModelType.LTX2, type=ModelType.Main, format=ModelFormat.Checkpoint
    )


def _denoise(**kwargs) -> LTX2DenoiseInvocation:
    defaults = {
        "transformer": LTX2TransformerField(transformer=_identifier(), variant=LTX2VariantType.Dev.value),
        "positive_conditioning": LTX2ConditioningField(conditioning_name="positive"),
        "negative_conditioning": LTX2ConditioningField(conditioning_name="negative"),
    }
    return LTX2DenoiseInvocation(id="denoise", **{**defaults, **kwargs})


def _context() -> MagicMock:
    context = MagicMock()
    context.logger = MagicMock()
    return context


@pytest.mark.parametrize(
    ("variant", "schedule", "expected"),
    [
        (LTX2VariantType.Distilled.value, "auto", True),
        (LTX2VariantType.Dev.value, "auto", False),
        (LTX2VariantType.Dev.value, "distilled", True),
        (LTX2VariantType.Distilled.value, "dev", False),
    ],
)
def test_the_schedule_follows_the_variant_unless_it_is_set_explicitly(
    variant: str, schedule: str, expected: bool
) -> None:
    """Sampling a distilled checkpoint on the dev schedule returns noise, so the default reads the
    variant the loader stamped rather than trusting a literal in the graph."""
    node = _denoise(transformer=LTX2TransformerField(transformer=_identifier(), variant=variant), schedule=schedule)
    assert node._resolve_distilled() is expected


def test_an_unstamped_transformer_cannot_resolve_the_schedule_automatically() -> None:
    node = _denoise(transformer=LTX2TransformerField(transformer=_identifier(), variant=None), schedule="auto")
    with pytest.raises(ValueError, match="Auto"):
        node._resolve_distilled()


def test_the_distilled_schedule_ignores_the_guidance_scales_and_says_so() -> None:
    """Guidance is baked into the distilled weights; steering it produces a saturated, broken clip,
    so this is not a preference a graph gets to override."""
    context = _context()
    guidance = _denoise()._resolve_guidance(context, distilled=True)

    assert guidance.passes == ("cond",)
    assert (guidance.cfg_scale, guidance.audio_cfg_scale, guidance.stg_scale, guidance.modality_scale) == (
        1.0,
        1.0,
        0.0,
        1.0,
    )
    assert context.logger.info.called


def test_the_dev_schedule_passes_the_graphs_guidance_scales_through() -> None:
    node = _denoise(cfg_scale=4.0, audio_cfg_scale=6.0, stg_scale=0.5, modality_scale=2.0, guidance_rescale=0.3)
    guidance = node._resolve_guidance(_context(), distilled=False)
    assert (guidance.cfg_scale, guidance.audio_cfg_scale, guidance.stg_scale, guidance.modality_scale) == (
        4.0,
        6.0,
        0.5,
        2.0,
    )
    assert guidance.rescale == 0.3


def test_guidance_without_a_negative_prompt_is_refused_before_a_model_loads() -> None:
    node = _denoise(negative_conditioning=None)
    context = _context()
    context.conditioning.load.return_value = SimpleNamespace(
        conditionings=[
            LTX2ConditioningInfo(
                video_embeds=torch.zeros(1, 4, 8),
                audio_embeds=torch.zeros(1, 4, 6),
                attention_mask=torch.ones(1, 4, dtype=torch.int64),
            )
        ]
    )
    with pytest.raises(ValueError, match="negative conditioning"):
        node.invoke(context)


def test_an_image_conditioning_from_another_canvas_is_refused_with_both_sizes() -> None:
    node = _denoise(
        width=1248,
        height=704,
        video_conditioning=LTX2VideoConditioningField(latents_name="latents", width=768, height=512),
    )
    with pytest.raises(ValueError, match="768x512"):
        node._load_image_latents(_context())


@pytest.mark.parametrize("num_frames", [120, 122])
def test_a_frame_count_off_the_vae_grid_is_refused(num_frames: int) -> None:
    with pytest.raises(ValueError, match="8n \\+ 1"):
        _denoise(num_frames=num_frames).invoke(_context())


def test_the_working_memory_estimate_grows_with_the_sequence() -> None:
    """Under-reserving packs VRAM with weights and kills the first forward; the estimate has to
    follow the row count rather than being a constant."""
    small = LTX2DenoiseInvocation._estimate_working_memory(320, 9)
    large = LTX2DenoiseInvocation._estimate_working_memory(13728, 126)
    assert large > small
    # Measured on a W7900 at these shapes: 0.46 GiB and 2.81 GiB.
    assert small > 0.46 * 2**30
    assert large > 2.81 * 2**30


def test_the_model_loader_refuses_a_single_file_transformer_with_no_component_folder() -> None:
    """A checkpoint carries the transformer alone; without a folder there is no VAE to decode with,
    and the failure would otherwise surface minutes later inside a loader."""
    node = LTX2ModelLoaderInvocation(
        id="loader",
        model=_identifier(),
        text_encoder_model=_identifier("encoder"),
    )
    context = _context()
    context.models.exists.return_value = True
    context.models.get_config.return_value = SimpleNamespace(
        base=BaseModelType.LTX2, type=ModelType.Main, name="LTX-2.5 Dev", format=ModelFormat.Checkpoint
    )
    with pytest.raises(ValueError, match="Components field"):
        node.invoke(context)


def test_the_model_loader_refuses_a_components_only_folder_as_the_model() -> None:
    node = LTX2ModelLoaderInvocation(id="loader", model=_identifier(), text_encoder_model=_identifier("encoder"))
    context = _context()
    context.models.exists.return_value = True
    context.models.get_config.return_value = Main_Diffusers_LTX2_Config.model_construct(
        base=BaseModelType.LTX2, type=ModelType.Main, name="LTX-2.5 Components", components_only=True
    )
    with pytest.raises(ValueError, match="components-only"):
        node.invoke(context)


def test_the_model_loader_refuses_a_model_from_another_architecture() -> None:
    node = LTX2ModelLoaderInvocation(id="loader", model=_identifier(), text_encoder_model=_identifier("encoder"))
    context = _context()
    context.models.exists.return_value = True
    context.models.get_config.return_value = SimpleNamespace(
        base=BaseModelType.Wan, type=ModelType.Main, name="Wan", format=ModelFormat.Diffusers
    )
    with pytest.raises(ValueError, match="Model field needs an LTX-2 main model"):
        node.invoke(context)


@pytest.mark.parametrize(
    ("source", "preset", "expected"),
    [((1920, 1080), "704p", (1248, 704)), ((1080, 1920), "512p", (512, 896)), ((1024, 1024), "768p", (768, 768))],
)
def test_the_ideal_dimensions_pin_the_short_edge(source, preset, expected) -> None:
    node = LTX2IdealDimensionsInvocation(id="dims", width=source[0], height=source[1], target_resolution=preset)
    output = node.invoke(MagicMock())
    assert (output.width, output.height) == expected
    # One pass: the base canvas is the canvas, so a workflow can wire one pair of numbers.
    assert (output.base_width, output.base_height) == expected
    assert output.two_stage is False


@pytest.mark.parametrize(
    ("source", "preset", "final", "base"),
    [
        ((1920, 1080), "1024p", (1792, 1024), (896, 512)),
        ((1920, 1080), "1536p", (2752, 1536), (1376, 768)),
        ((1080, 1920), "1024p", (1024, 1792), (512, 896)),
    ],
)
def test_a_two_stage_preset_resolves_on_the_64_grid_and_names_its_base_pass(source, preset, final, base) -> None:
    """The node's choice of grid is what makes the base canvas expressible at all: a two-stage canvas
    off the 64 grid halves onto something the VAE cannot encode, and only a live run would notice."""
    node = LTX2IdealDimensionsInvocation(id="dims", width=source[0], height=source[1], target_resolution=preset)
    output = node.invoke(MagicMock())

    assert (output.width, output.height) == final
    assert (output.base_width, output.base_height) == base
    assert output.two_stage is True
    assert (output.base_width * 2, output.base_height * 2) == final
    assert output.base_width % 32 == 0 and output.base_height % 32 == 0


def test_fitting_an_image_to_the_canvas_crops_rather_than_stretches() -> None:
    """A stretched first frame teaches the model the wrong geometry for the whole clip."""
    source = Image.new("RGB", (1000, 500), "red")
    source.paste(Image.new("RGB", (100, 100), "blue"), (450, 200))

    fitted = fit_to_canvas(source, 704, 704)

    assert fitted.size == (704, 704)
    # A 2:1 source cover-cropped to a square keeps the centre, so the blue patch survives.
    assert fitted.getpixel((352, 352)) == (0, 0, 255)


def test_the_crf_round_trip_returns_a_recompressed_frame_of_the_same_size() -> None:
    """The conditioning image has to carry codec artefacts; the round trip goes through ffmpeg,
    whose two-process pipe is easy to get subtly wrong."""
    torch.manual_seed(0)
    noise = (torch.rand(96, 128, 3) * 255).byte().numpy()
    source = Image.fromarray(noise, "RGB")

    recompressed = recompress_h264(source, 18)

    assert recompressed.size == source.size
    assert recompressed.tobytes() != source.tobytes()
    assert recompress_h264(source, 0) is source


def test_an_odd_sized_image_is_cropped_to_what_h264_can_encode() -> None:
    source = Image.new("RGB", (65, 33), "green")
    assert recompress_h264(source, 18).size == (64, 32)


def _latents_to_video(**kwargs) -> LTX2LatentsToVideoInvocation:
    defaults = {
        "video_latents": LatentsField(latents_name="video"),
        "audio_latents": LatentsField(latents_name="audio"),
        "vae": VAEField(vae=_identifier("vae")),
        "audio_vae": VAEField(vae=_identifier("audio_vae")),
        "vocoder": LTX2VocoderField(vocoder=_identifier("vocoder")),
    }
    return LTX2LatentsToVideoInvocation(id="l2v", **{**defaults, **kwargs})


def test_audio_latents_without_their_decoders_name_both_missing_models() -> None:
    """The graph always wires all three, so this catches a hand-built workflow before it decodes a
    whole clip and then finds it has nothing to turn the soundtrack into."""
    node = _latents_to_video(audio_vae=None, vocoder=None)

    with pytest.raises(ValueError, match="Audio VAE and Vocoder"):
        node._decode_audio_to_wav(_context(), 5.0)


@pytest.mark.parametrize(
    ("decoded_seconds", "clip_seconds"),
    [
        # The audio VAE's causal decoder drops its first few mel frames, so the soundtrack comes
        # back a fraction short of the clip: the normal case, and the one the pad exists for.
        (4.97, 5.0),
        # And a grid that overshoots has to be cut, or the mux would run past the last frame.
        (5.2, 5.0),
        (5.0, 5.0),
    ],
)
def test_the_soundtrack_is_written_at_exactly_the_clip_duration(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, decoded_seconds: float, clip_seconds: float
) -> None:
    sample_rate = 48000
    decoded = torch.zeros(2, int(decoded_seconds * sample_rate))
    decoded[:, : decoded.shape[1] // 2] = 0.5

    monkeypatch.setattr(ltx2_latents_to_video, "decode_audio_latents", lambda *_a, **_k: decoded)
    context = _context()
    context.tensors.load.return_value = torch.zeros(1, 126, 128)
    context.models.load.return_value.model_on_device.return_value.__enter__.return_value = (
        None,
        SimpleNamespace(config=SimpleNamespace(output_sampling_rate=sample_rate)),
    )

    wav_path = _latents_to_video()._decode_audio_to_wav(context, clip_seconds)
    try:
        with wave.open(str(wav_path)) as handle:
            assert handle.getnchannels() == 2
            assert handle.getframerate() == sample_rate
            assert handle.getnframes() == int(round(clip_seconds * sample_rate))
    finally:
        wav_path.unlink(missing_ok=True)


def test_a_mono_soundtrack_is_refused_rather_than_written_as_half_a_file(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ltx2_latents_to_video, "decode_audio_latents", lambda *_a, **_k: torch.zeros(1, 48000))
    context = _context()
    context.tensors.load.return_value = torch.zeros(1, 126, 128)
    context.models.load.return_value.model_on_device.return_value.__enter__.return_value = (
        None,
        SimpleNamespace(config=SimpleNamespace(output_sampling_rate=48000)),
    )

    with pytest.raises(ValueError, match="expected stereo"):
        _latents_to_video()._decode_audio_to_wav(context, 1.0)


def test_unpacked_audio_latents_are_refused_before_a_model_is_locked() -> None:
    context = _context()
    context.tensors.load.return_value = torch.zeros(1, 8, 126, 16)

    with pytest.raises(ValueError, match=r"packed \[1, L, 128\]"):
        _latents_to_video()._decode_audio_to_wav(context, 5.0)


def test_a_refine_pass_without_the_base_passs_audio_is_refused() -> None:
    """The two modalities are denoised jointly off one pair of timesteps, so the refine pass takes
    both of stage one's outputs or neither -- wiring only the video would leave the audio to be
    generated from scratch beside an almost-finished clip."""
    node = _denoise(latents=LatentsField(latents_name="upscaled"))

    with pytest.raises(ValueError, match="audio latents as well as its video"):
        node.invoke(_context())


def test_audio_latents_without_video_latents_are_refused() -> None:
    node = _denoise(audio_latents=LatentsField(latents_name="audio"))

    with pytest.raises(ValueError, match="takes both or neither"):
        node.invoke(_context())


def test_the_upscaler_refuses_latents_that_are_not_one_ltx2_clip() -> None:
    node = LTX2LatentUpsampleInvocation(
        id="upsample",
        video_latents=LatentsField(latents_name="latents"),
        latent_upsampler=LTX2LatentUpsamplerField(latent_upsampler=_identifier("upsampler")),
        vae=VAEField(vae=_identifier("vae")),
    )
    context = _context()
    context.tensors.load.return_value = torch.zeros(1, 16, 4, 8, 8)

    with pytest.raises(ValueError, match="expects one 5D clip"):
        node.invoke(context)


def test_the_upscaler_hands_the_network_raw_latents_and_returns_normalized_ones(monkeypatch) -> None:
    """The scale conversion is the whole reason the VAE is wired into this node: the upscaler was
    trained on the VAE's own latent scale while the transformer reads normalized latents. Swapping
    the two conversions, or dropping either, leaves a wildly mis-scaled latent that only shows up as
    garbage after the refine pass -- by which time the base pass has already run."""
    mean = torch.full((1, 128, 1, 1, 1), 3.0)
    std = torch.full((1, 128, 1, 1, 1), 2.0)
    scaling_factor = 0.5
    seen: dict[str, torch.Tensor] = {}

    class StubUpsampler(torch.nn.Module):
        # Carries the same submodule names as the real `LTX2LatentUpsamplerModel`, as real modules:
        # the node hooks them for cancellation, so a stub of bare lists would let a typo'd or
        # renamed attribute pass here and fail only against the released checkpoint.
        def __init__(self) -> None:
            super().__init__()
            self.weight = torch.nn.Parameter(torch.zeros(1))
            self.initial_conv = torch.nn.Identity()
            self.res_blocks = torch.nn.ModuleList([torch.nn.Identity()])
            self.upsampler = torch.nn.Identity()
            self.post_upsample_res_blocks = torch.nn.ModuleList([torch.nn.Identity()])
            self.final_conv = torch.nn.Identity()

        def forward(self, hidden_states: torch.Tensor) -> torch.Tensor:
            seen["input"] = hidden_states.detach().clone()
            return hidden_states.repeat_interleave(2, dim=-1).repeat_interleave(2, dim=-2)

    upsampler = StubUpsampler()
    vae = SimpleNamespace(latents_mean=mean, latents_std=std, config=SimpleNamespace(scaling_factor=scaling_factor))

    context = _context()
    normalized_in = torch.randn(1, 128, 2, 4, 6)
    context.tensors.load.return_value = normalized_in

    def save(tensor: torch.Tensor) -> str:
        seen["saved"] = tensor.clone()
        return "saved"

    context.tensors.save.side_effect = save

    def load(identifier):
        if identifier.key == "vae":
            return SimpleNamespace(model=vae, config=SimpleNamespace(base=BaseModelType.LTX2))
        loaded = MagicMock()
        loaded.model_on_device.return_value.__enter__.return_value = (None, upsampler)
        return loaded

    context.models.load.side_effect = load
    monkeypatch.setattr(TorchDevice, "choose_torch_device", staticmethod(lambda: torch.device("cpu")))

    node = LTX2LatentUpsampleInvocation(
        id="upsample",
        video_latents=LatentsField(latents_name="latents"),
        latent_upsampler=LTX2LatentUpsamplerField(latent_upsampler=_identifier("upsampler")),
        vae=VAEField(vae=_identifier("vae")),
    )
    output = node.invoke(context)

    # In: denormalized to the VAE's own scale. Out: back on the transformer's.
    torch.testing.assert_close(seen["input"], normalized_in * std / scaling_factor + mean)
    torch.testing.assert_close(
        seen["saved"],
        (seen["input"].repeat_interleave(2, dim=-1).repeat_interleave(2, dim=-2) - mean) * scaling_factor / std,
    )
    # Pixel geometry, not `size()[3] * 8`: 4x6 latents doubled is 8x12, at 32 px per latent.
    assert (output.width, output.height, output.num_frames) == (12 * 32, 8 * 32, (2 - 1) * 8 + 1)


def test_the_refine_pass_forwards_the_noise_level_the_node_was_given(monkeypatch) -> None:
    """`noise_scale` is the only knob this feature adds, and nothing else reaches the schedule it
    controls without a 22B transformer resident. Hard-coding it at the call site is otherwise free."""
    import invokeai.app.invocations.ltx2.ltx2_denoise as denoise_module

    captured: dict[str, float] = {}

    def fake_build_refine_state(**kwargs):
        captured["noise_scale"] = kwargs["noise_scale"]
        raise _StopAfterState

    monkeypatch.setattr(denoise_module, "build_refine_state", fake_build_refine_state)
    node = _denoise(
        latents=LatentsField(latents_name="upscaled"),
        audio_latents=LatentsField(latents_name="audio"),
        noise_scale=0.42,
        cfg_scale=1.0,
        audio_cfg_scale=1.0,
        stg_scale=0.0,
        modality_scale=1.0,
    )

    context = _context()
    context.conditioning.load.return_value = SimpleNamespace(
        conditionings=[
            LTX2ConditioningInfo(
                video_embeds=torch.zeros(1, 4, 8),
                audio_embeds=torch.zeros(1, 4, 6),
                attention_mask=torch.ones(1, 4, dtype=torch.int64),
            )
        ]
    )

    with pytest.raises(_StopAfterState):
        node.invoke(context)

    assert captured["noise_scale"] == 0.42


# ---------------------------------------------------------------------------
# Whole-modality conditioning: a clip's soundtrack, or its picture


def _audio_conditioning(**kwargs) -> LTX2AudioConditioningInvocation:
    defaults = {
        "video": VideoField(video_name="clip.mp4"),
        "audio_vae": VAEField(vae=_identifier("audio_vae")),
        "vocoder": LTX2VocoderField(vocoder=_identifier("vocoder")),
    }
    return LTX2AudioConditioningInvocation(id="audio_cond", **{**defaults, **kwargs})


def _video_conditioning(**kwargs) -> LTX2VideoConditioningInvocation:
    defaults = {"video": VideoField(video_name="clip.mp4"), "vae": VAEField(vae=_identifier("vae"))}
    return LTX2VideoConditioningInvocation(id="video_cond", **{**defaults, **kwargs})


def _ltx2_vae_context(base: BaseModelType = BaseModelType.LTX2) -> MagicMock:
    context = _context()
    context.models.load.return_value.config.base = base
    context.models.load.return_value.model_on_device.return_value.__enter__.return_value = (None, MagicMock())
    return context


def test_a_clip_with_no_soundtrack_says_so_instead_of_conditioning_on_silence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A silent clip would encode to a valid, uniformly quiet latent -- the model would hold it
    clean and generate a picture scored against nothing."""
    monkeypatch.setattr(ltx2_audio_conditioning, "extract_audio_pcm", lambda *_a, **_k: None)

    with pytest.raises(ValueError, match="no audio track"):
        _audio_conditioning().invoke(_ltx2_vae_context())


@pytest.mark.parametrize("node", ["audio", "video"])
def test_a_conditioning_node_refuses_a_vae_from_another_architecture(
    monkeypatch: pytest.MonkeyPatch, node: str
) -> None:
    monkeypatch.setattr(ltx2_audio_conditioning, "extract_audio_pcm", lambda *_a, **_k: (np.zeros((2, 48000)), 48000))
    invocation = _audio_conditioning() if node == "audio" else _video_conditioning()

    with pytest.raises(ValueError, match="Expected an LTX-2"):
        invocation.invoke(_ltx2_vae_context(BaseModelType.Wan))


@pytest.mark.parametrize(
    ("audio_latents", "fps", "expected_frames"),
    [
        # 25 audio latents per second: 100 latents is four seconds, which at 24 fps is 96 frames
        # and snaps DOWN to 89 -- the clip is never asked to cover more picture than it has sound.
        (100, 24.0, 89),
        (100, 30.0, 113),
        # A rate that divides evenly still snaps down rather than to the nearest.
        (75, 24.0, 65),
    ],
)
def test_the_soundtracks_length_decides_the_frame_count(
    monkeypatch: pytest.MonkeyPatch, audio_latents: int, fps: float, expected_frames: int
) -> None:
    monkeypatch.setattr(ltx2_audio_conditioning, "extract_audio_pcm", lambda *_a, **_k: (np.zeros((2, 48000)), 48000))
    monkeypatch.setattr(
        ltx2_audio_conditioning,
        "encode_audio_latents",
        lambda *_a, **_k: torch.zeros(1, audio_latents, LTX2_AUDIO_LATENT_CHANNELS * LTX2_AUDIO_LATENT_MEL_BINS),
    )
    context = _ltx2_vae_context()
    context.tensors.save.return_value = "audio_conditioning"

    output = _audio_conditioning(fps=fps).invoke(context)

    assert output.num_frames == expected_frames
    validate_num_frames(output.num_frames)
    assert output.fps == fps
    # The saved soundtrack is trimmed to the span the frame count covers, so the field reports that
    # count rather than everything the encoder produced -- see the seam test below.
    assert output.audio_conditioning.num_audio_latents == audio_latent_count(expected_frames, fps)
    # The output field carries the clip back to the decode node, which muxes the original
    # recording in place of the generated soundtrack.
    assert output.audio_conditioning.source_video_name == "clip.mp4"


@pytest.mark.parametrize(
    ("audio_latents", "fps"),
    [(100, 24.0), (100, 30.0), (75, 24.0), (125, 25.0), (251, 24.0), (1000, 60.0), (63, 16.0)],
)
def test_the_soundtrack_this_node_saves_is_the_one_the_denoise_asks_for(
    monkeypatch: pytest.MonkeyPatch, audio_latents: int, fps: float
) -> None:
    """The seam between the two halves of audio-to-video, which neither side can check alone.

    This node decides the frame count; `build_denoise_state` then sizes the audio stream from that
    count and refuses a tensor of any other length. Because the count is snapped DOWN, it spans
    slightly less than the recording -- so saving the whole encode makes the two disagree on every
    real soundtrack, and the run dies after the text encoder has already paid for itself.
    """
    monkeypatch.setattr(ltx2_audio_conditioning, "extract_audio_pcm", lambda *_a, **_k: (np.zeros((2, 48000)), 48000))
    monkeypatch.setattr(
        ltx2_audio_conditioning,
        "encode_audio_latents",
        lambda *_a, **_k: torch.zeros(1, audio_latents, LTX2_AUDIO_LATENT_CHANNELS * LTX2_AUDIO_LATENT_MEL_BINS),
    )
    saved: dict[str, torch.Tensor] = {}
    context = _ltx2_vae_context()

    def capture(tensor: torch.Tensor) -> str:
        saved["latents"] = tensor
        return "audio"

    context.tensors.save.side_effect = capture

    output = _audio_conditioning(fps=fps).invoke(context)

    # The real denoise state, built exactly as the graph builds it: the node's own frame count and
    # frame rate, and the tensor it actually saved.
    state = build_denoise_state(
        num_frames=output.num_frames,
        height=512,
        width=768,
        fps=output.fps,
        seed=1,
        distilled=False,
        num_steps=2,
        frozen_audio_latents=saved["latents"],
    )

    assert state.audio_conditioning_mask is not None
    assert state.audio_conditioning_mask.shape == (1, state.audio_latents_count)
    assert state.audio_latents.shape[1] == state.audio_latents_count
    # And the node reports what it saved, so the field is not a second, divergent source of truth.
    assert output.audio_conditioning.num_audio_latents == saved["latents"].shape[1]


def test_a_soundtrack_under_one_frame_group_is_refused_with_its_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ltx2_audio_conditioning, "extract_audio_pcm", lambda *_a, **_k: (np.zeros((2, 4800)), 48000))
    monkeypatch.setattr(
        ltx2_audio_conditioning,
        "encode_audio_latents",
        lambda *_a, **_k: torch.zeros(1, 5, LTX2_AUDIO_LATENT_CHANNELS * LTX2_AUDIO_LATENT_MEL_BINS),
    )

    with pytest.raises(ValueError, match="0.20s long"):
        _audio_conditioning().invoke(_ltx2_vae_context())


def test_the_conditioning_clip_drops_its_ragged_tail_rather_than_padding_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Padding would invent picture for the model to score a soundtrack against; the frames past
    the last whole group are simply not part of the generation."""
    frames = [np.full((64, 64, 3), index % 256, dtype=np.uint8) for index in range(20)]
    encoded: dict[str, torch.Tensor] = {}

    monkeypatch.setattr(ltx2_video_conditioning, "iter_video_frames", lambda *_a, **_k: iter(frames))

    def encode(pixels):
        encoded["pixels"] = pixels
        latent_frames = latent_frame_count(17)
        return SimpleNamespace(
            latent_dist=SimpleNamespace(
                mode=lambda: torch.zeros(1, LTX2_LATENT_CHANNELS, latent_frames, 512 // 32, 768 // 32)
            )
        )

    # The encode is tiled, so the stub carries the compression ratios and the tiling attributes
    # `scoped_ltx2_tiling` snapshots and restores -- a VAE missing them is one this node cannot run.
    vae = SimpleNamespace(
        config=SimpleNamespace(scaling_factor=1.0),
        enable_tiling=lambda **_kwargs: None,
        encode=encode,
        latents_mean=torch.zeros(LTX2_LATENT_CHANNELS),
        latents_std=torch.ones(LTX2_LATENT_CHANNELS),
        buffers=lambda: iter([]),
        encoder=torch.nn.Identity(),
        parameters=lambda: iter([torch.zeros(1)]),
        spatial_compression_ratio=32,
        temporal_compression_ratio=8,
        use_framewise_encoding=False,
        use_framewise_decoding=False,
        use_tiling=False,
    )
    context = _ltx2_vae_context()
    context.models.load.return_value.model_on_device.return_value.__enter__.return_value = (None, vae)
    context.tensors.save.return_value = "video_conditioning"

    output = _video_conditioning(width=768, height=512).invoke(context)

    # 20 frames is two whole groups plus three: 17 frames run, three are dropped.
    assert output.num_frames == 17
    assert encoded["pixels"].shape == (1, 3, 17, 512, 768)
    # And the frames arrive in [-1, 1] with the VAE's own scaling, not raw bytes. The conversion
    # runs in the VAE's dtype to avoid a second copy of the clip, so the order of operations
    # matters: `x / 127.5 - 1` cancels at mid-grey in bf16 and loses the value entirely.
    sources = torch.tensor([index % 256 for index in range(17)], dtype=torch.float32)
    expected = sources.div(127.5).sub(1.0)
    assert torch.allclose(encoded["pixels"][0, 0, :, 0, 0].float(), expected, atol=2e-3)
    assert output.video_conditioning.width == 768
    assert output.video_conditioning.height == 512


def test_a_conditioning_clip_under_one_frame_group_is_refused_with_its_length(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        ltx2_video_conditioning,
        "iter_video_frames",
        lambda *_a, **_k: iter([np.zeros((64, 64, 3), dtype=np.uint8) for _ in range(5)]),
    )

    with pytest.raises(ValueError, match="decoded to 5 frame"):
        _video_conditioning().invoke(_ltx2_vae_context())


@pytest.mark.parametrize(
    "conditioning",
    [
        {
            "audio_conditioning": LTX2AudioConditioningField(
                latents_name="audio", num_audio_latents=100, num_frames=89, fps=24.0, source_video_name="clip.mp4"
            )
        },
        {
            "full_video_conditioning": LTX2FullVideoConditioningField(
                latents_name="video", width=1248, height=704, num_frames=89, fps=24.0
            )
        },
    ],
)
def test_a_held_modality_cannot_be_combined_with_a_refine_pass(conditioning: dict) -> None:
    """The refine pass re-noises every token, so the held stream would have to be re-encoded at the
    second canvas. Refused before the transformer loads rather than silently dropped."""
    node = _denoise(
        latents=LatentsField(latents_name="upscaled"),
        audio_latents=LatentsField(latents_name="audio"),
        num_frames=89,
        **conditioning,
    )

    with pytest.raises(ValueError, match="does not run a refine pass"):
        node.invoke(_context())


@pytest.mark.parametrize(
    ("conditioning", "expected"),
    [
        (
            {
                "audio_conditioning": LTX2AudioConditioningField(
                    latents_name="audio", num_audio_latents=93, num_frames=89, fps=30.0, source_video_name="clip.mp4"
                )
            },
            "fps 30.0 vs 24.0",
        ),
        (
            {
                "full_video_conditioning": LTX2FullVideoConditioningField(
                    latents_name="video", width=768, height=704, num_frames=89, fps=24.0
                )
            },
            "width 768 vs 1248",
        ),
    ],
)
def test_a_conditioning_prepared_for_a_different_run_is_named_before_the_transformer_loads(
    conditioning: dict, expected: str
) -> None:
    """`fps` is the one the latent shapes cannot catch -- no tensor encodes it -- and it sets the
    audio stream's length, so a mismatch would quietly generate a soundtrack for the wrong
    duration. The canvas and frame count are checked here too, where the message can name them."""
    node = _denoise(num_frames=89, fps=24.0, width=1248, height=704, **conditioning)

    with pytest.raises(ValueError, match=expected):
        node.invoke(_context())


class _StopAfterState(Exception):
    """Ends the invocation once the state has been built, before any model is loaded."""
