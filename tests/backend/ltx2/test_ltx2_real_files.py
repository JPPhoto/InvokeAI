"""The LTX-2.5 loaders over the released files (slow lane: needs the weights on disk).

Every component's pinned config and key map were derived from the released files' headers; this is
the check that the real tensors land in the real diffusers modules and that the Gemma-4 text tower
built by ``Gemma4TextModel`` runs. Skipped unless the ``DeepBeepMeep/LTX-2`` snapshot is in the
Hugging Face cache (``INVOKEAI_LTX2_SNAPSHOT`` overrides the path).
"""

import os
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch

from invokeai.backend.ltx2 import checkpoint_layout as layout
from invokeai.backend.model_manager.configs.gemma4_encoder import Gemma4Encoder_Gemma4Encoder_LTX2_Config
from invokeai.backend.model_manager.configs.main import Main_Checkpoint_LTX2_Config, Main_Diffusers_LTX2_Config
from invokeai.backend.model_manager.load.model_loaders.ltx2 import (
    LTX2CheckpointModel,
    LTX2FolderModel,
    LTX2Gemma4EncoderModel,
)
from invokeai.backend.model_manager.taxonomy import LTX2VariantType, SubModelType
from invokeai.backend.util.devices import TorchDevice

pytestmark = pytest.mark.slow


def _snapshot() -> Path | None:
    override = os.environ.get("INVOKEAI_LTX2_SNAPSHOT")
    if override:
        return Path(override)
    hub = (
        Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface")) / "hub" / "models--DeepBeepMeep--LTX-2"
    )
    snapshots = sorted((hub / "snapshots").glob("*")) if hub.exists() else []
    return snapshots[-1] if snapshots else None


SNAPSHOT = _snapshot()
COMPONENTS = {
    layout.ROLE_VIDEO_VAE: "ltx-2.5-22b_video_vae_bf16.safetensors",
    layout.ROLE_AUDIO_VAE: "ltx-2.5-22b_audio_vae_bf16.safetensors",
    layout.ROLE_VOCODER: "ltx-2.5-22b_vocoder_bf16.safetensors",
    layout.ROLE_TEXT_PROJECTION: "ltx-2.5-22b_text_embedding_projection_bf16.safetensors",
    layout.ROLE_VIDEO_CONNECTOR: "ltx-2.5-22b_video_embeddings_connector_bf16.safetensors",
    layout.ROLE_AUDIO_CONNECTOR: "ltx-2.5-22b_audio_embeddings_connector_bf16.safetensors",
    layout.ROLE_SPATIAL_UPSAMPLER: "ltx-2.5-spatial-upscaler-x2-1.0_bf16.safetensors",
    layout.ROLE_TEMPORAL_UPSAMPLER: "ltx-2.5-temporal-upscaler-x2-1.0_bf16.safetensors",
}
requires_weights = pytest.mark.skipif(
    SNAPSHOT is None or not all((SNAPSHOT / name).exists() for name in COMPONENTS.values()),
    reason="the LTX-2.5 release files are not in the Hugging Face cache",
)


def _loader(cls):
    loader = object.__new__(cls)
    loader._ram_cache = SimpleNamespace(make_room=lambda _n: None)
    loader._logger = SimpleNamespace(info=lambda *_a, **_k: None, warning=lambda *_a, **_k: None)
    loader._torch_device = torch.device("cpu")
    loader._apply_fp8_layerwise_casting = lambda model, _c, _s: model
    return loader


def _no_meta(model: torch.nn.Module) -> None:
    assert not any(p.is_meta for p in model.parameters()) and not any(b.is_meta for b in model.buffers())


@requires_weights
@pytest.mark.parametrize(
    ("submodel", "expected_class"),
    [
        (SubModelType.VAE, "AutoencoderKLLTX2Video"),
        (SubModelType.AudioVAE, "AutoencoderKLLTX2Audio"),
        (SubModelType.Vocoder, "LTX2VocoderWithBWE"),
        (SubModelType.Connectors, "LTX2TextConnectors"),
        (SubModelType.LatentUpsampler, "LTX2LatentUpsamplerModel"),
        (SubModelType.TemporalLatentUpsampler, "LTX2LatentUpsamplerModel"),
    ],
)
def test_every_released_component_lands_in_its_diffusers_module(submodel, expected_class) -> None:
    config = Main_Diffusers_LTX2_Config.model_construct(
        path=str(SNAPSHOT), components=dict(COMPONENTS), components_only=True, variant=LTX2VariantType.Dev
    )
    model = _loader(LTX2FolderModel)._load_model(config, submodel)
    assert type(model).__name__ == expected_class
    _no_meta(model)


@requires_weights
def test_the_int8_transformer_builds_with_its_layers_packed() -> None:
    path = SNAPSHOT / "ltx-2.5-22b-dev_diffusion_model_int8_convrot.safetensors"
    if not path.exists():
        pytest.skip("int8 dev transformer not downloaded")
    from invokeai.backend.quantization.int8_convrot import Int8ConvrotLinear

    config = Main_Checkpoint_LTX2_Config.model_construct(
        path=str(path), variant=LTX2VariantType.Dev, generation="2.5", fp8_storage=None
    )
    model = _loader(LTX2CheckpointModel)._load_model(config, SubModelType.Transformer)
    _no_meta(model)
    assert isinstance(model.transformer_blocks[0].attn1.to_q, Int8ConvrotLinear)
    assert model.config.use_keyframes_abs_pos_embedding is True
    assert len(model.transformer_blocks) == 48


@requires_weights
def test_the_gemma4_tower_runs_and_yields_all_forty_nine_hidden_states() -> None:
    root = SNAPSHOT / "gemma4-12b-ltx-v1"
    weight = "gemma4-12b-ltx-v1_int8_convrot.safetensors"
    if not (root / weight).exists():
        pytest.skip("int8 Gemma-4 encoder not downloaded")
    device = TorchDevice.choose_torch_device()
    if device.type == "cpu":
        pytest.skip("needs an accelerator for a 12B forward")
    config = Gemma4Encoder_Gemma4Encoder_LTX2_Config.model_construct(path=str(root), subfolder="", weight_file=weight)
    loader = _loader(LTX2Gemma4EncoderModel)
    tokenizer = loader._load_model(config, SubModelType.Tokenizer)
    model = loader._load_model(config, SubModelType.TextEncoder)
    _no_meta(model)

    model.to(device)
    tokenizer.padding_side = "left"
    batch = tokenizer(
        ["A cat on a windowsill, purring."], padding="max_length", max_length=64, truncation=True, return_tensors="pt"
    )
    with torch.inference_mode():
        out = model(
            input_ids=batch.input_ids.to(device),
            attention_mask=batch.attention_mask.to(device),
            output_hidden_states=True,
        )
    assert len(out.hidden_states) == 49
    stacked = torch.stack(out.hidden_states, dim=-1)
    assert stacked.shape == (1, 64, 3840, 49)
    assert torch.isfinite(stacked).all()
    # The tower is doing work: the last layer is not a rescaled copy of the embedding output.
    assert not torch.allclose(out.hidden_states[-1].float(), out.hidden_states[0].float(), atol=1.0)


@pytest.mark.skipif(
    SNAPSHOT is None or not (SNAPSHOT / "gemma4-12b-ltx-v1" / "tokenizer.json").exists(),
    reason="the Gemma-4 tokenizer is not in the Hugging Face cache",
)
def test_the_released_tokenizer_keeps_the_words_the_mistral_fix_would_shatter() -> None:
    """transformers advises the Mistral regex fix for this folder. Taking it prepends the Tekken
    split regex to Gemma's pre-tokenizer, which fragments words this vocabulary has whole -- every
    prompt would then encode differently from what the reference pipelines feed the tower. The
    synthetic folder in the loader suite pins the warnings; this pins the tokenization itself."""
    root = SNAPSHOT / "gemma4-12b-ltx-v1"
    config = Gemma4Encoder_Gemma4Encoder_LTX2_Config.model_construct(
        path=str(root), subfolder="", weight_file="gemma4-12b-ltx-v1_bf16.safetensors"
    )
    tokenizer = _loader(LTX2Gemma4EncoderModel)._load_model(config, SubModelType.Tokenizer)

    tokens = tokenizer.convert_ids_to_tokens(
        tokenizer("worst quality, inconsistent motion, blurry, jittery, distorted").input_ids
    )
    # Exactly the words the Mistral split shatters ("in"+"consistent", "bl"+"urry", "dist"+"orted").
    assert {"\u2581inconsistent", "\u2581blurry", "\u2581distorted"} <= set(tokens)


@requires_weights
def test_the_mirror_s_nvfp4_transformer_is_refused_for_naming_no_layer() -> None:
    """WanGP's nvfp4 repack carries no marker and no header entry for its 1176 packed layers, so the
    block-scale layout cannot be known; the nvfp4 reader refuses it by name. Pinned so a future
    release that does name its layers is noticed here, not by a user."""
    path = SNAPSHOT / "ltx-2.5-22b-distilled_diffusion_model_nvfp4.safetensors"
    if not path.exists():
        pytest.skip("nvfp4 distilled transformer not downloaded")
    config = Main_Checkpoint_LTX2_Config.model_construct(
        path=str(path), variant=LTX2VariantType.Distilled, generation="2.5", fp8_storage=None
    )
    with pytest.raises(ValueError, match="nvfp4"):
        _loader(LTX2CheckpointModel)._load_model(config, SubModelType.Transformer)
