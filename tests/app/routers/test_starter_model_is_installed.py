"""A Qwen3 encoder starter counts as installed when any encoder of its size is.

The Z-Image and FLUX.2 Klein starters depend on a Qwen3 encoder, and every such encoder of one size serves them
alike. Recognising the size only by the source spellings BFL and Tongyi use (`qwen3_4b`, `Z-Image`) left out
Comfy-Org's `qwen_3_4b_fp4_mixed`: installing "Z-Image Turbo (NVFP4)" beside an installed 4B encoder would queue a
redundant 3.5GB download.
"""

from invokeai.app.api.routers.model_manager import get_is_installed
from invokeai.backend.model_manager.configs.qwen3_encoder import Qwen3Encoder_Checkpoint_Config
from invokeai.backend.model_manager.starter_models.common import z_image_qwen3_encoder_fp4
from invokeai.backend.model_manager.taxonomy import Qwen3VariantType


def _installed_encoder(variant: Qwen3VariantType) -> Qwen3Encoder_Checkpoint_Config:
    return Qwen3Encoder_Checkpoint_Config.model_construct(
        key="installed",
        name=f"my {variant.value} encoder",
        source=f"D:/models/{variant.value}.safetensors",
        variant=variant,
    )


def test_the_fp4_encoder_starter_is_satisfied_by_an_installed_4b_encoder() -> None:
    assert get_is_installed(z_image_qwen3_encoder_fp4, [_installed_encoder(Qwen3VariantType.Qwen3_4B)])


def test_an_installed_8b_encoder_does_not_satisfy_the_4b_starter() -> None:
    assert not get_is_installed(z_image_qwen3_encoder_fp4, [_installed_encoder(Qwen3VariantType.Qwen3_8B)])
