"""LTX-2 node contracts that do not need a model: what each node refuses, and why."""

import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
import torch
from PIL import Image

import invokeai.app.invocations.vae.ltx2_latents_to_video as ltx2_latents_to_video
from invokeai.app.invocations.fields import LatentsField, LTX2ConditioningField, LTX2VideoConditioningField
from invokeai.app.invocations.ltx2.ltx2_denoise import LTX2DenoiseInvocation
from invokeai.app.invocations.ltx2.ltx2_ideal_dimensions import LTX2IdealDimensionsInvocation
from invokeai.app.invocations.ltx2.ltx2_model_loader import LTX2ModelLoaderInvocation
from invokeai.app.invocations.model import (
    LTX2TransformerField,
    LTX2VocoderField,
    ModelIdentifierField,
    VAEField,
)
from invokeai.app.invocations.vae.ltx2_latents_to_video import LTX2LatentsToVideoInvocation
from invokeai.backend.ltx2.image_conditioning import fit_to_canvas, recompress_h264
from invokeai.backend.model_manager.configs.main import Main_Diffusers_LTX2_Config
from invokeai.backend.model_manager.taxonomy import BaseModelType, LTX2VariantType, ModelFormat, ModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import LTX2ConditioningInfo


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
