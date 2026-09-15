"""The default settings a model is identified with.

FP8 Storage is switched on for a checkpoint whose denoiser weights are stored in float8, read from the weights' dtypes
and never from the file name: a Comfy "fp8_scaled" file that nobody renamed and a full-precision file that somebody did
must both come out right. Settings passed along with an install land on top of what identification chose.

Single files are tiny Qwen-Image checkpoints, the smallest main model identification recognises from real keys. Folders
are the installer's SDXL diffusers fixture, whose placeholder weight files have no readable header at all.
"""

import shutil
from pathlib import Path

import pytest
import torch
from safetensors.torch import save_file

from invokeai.backend.model_manager.configs.factory import ModelConfigFactory
from invokeai.backend.model_manager.configs.main import Main_Checkpoint_QwenImage_Config
from invokeai.backend.model_manager.taxonomy import ModelType

_DIFFUSERS_FIXTURE = Path(__file__).parents[1] / "data" / "test_files" / "test-diffusers-main"


def _qwen_image_checkpoint(path: Path, weight_dtype: torch.dtype, **extra: torch.Tensor) -> Path:
    tensors = {
        "img_in.weight": torch.zeros(8, 4).to(weight_dtype),
        "txt_in.weight": torch.zeros(8, 4).to(weight_dtype),
        "txt_norm.weight": torch.ones(4),
        **extra,
    }
    save_file(tensors, str(path))
    return path


def _identify(path: Path, override_fields: dict | None = None) -> Main_Checkpoint_QwenImage_Config:
    result = ModelConfigFactory.from_model_on_disk(path, override_fields, allow_unknown=False)
    assert isinstance(result.config, Main_Checkpoint_QwenImage_Config), result.details
    return result.config


@pytest.mark.parametrize("fp8_dtype", [torch.float8_e4m3fn, torch.float8_e5m2])
def test_float8_denoiser_weights_turn_fp8_storage_on_whatever_the_file_is_called(tmp_path: Path, fp8_dtype) -> None:
    config = _identify(_qwen_image_checkpoint(tmp_path / "qwen_image.safetensors", fp8_dtype))

    assert config.default_settings is not None
    assert config.default_settings.fp8_storage is True


def test_a_full_precision_file_named_fp8_is_left_alone(tmp_path: Path) -> None:
    config = _identify(_qwen_image_checkpoint(tmp_path / "qwen_image_fp8_scaled.safetensors", torch.bfloat16))

    assert config.default_settings is None or config.default_settings.fp8_storage is None


def test_float8_weights_of_a_bundled_text_encoder_do_not_count(tmp_path: Path) -> None:
    """All-in-one checkpoints ship an fp8 text encoder beside a full-precision denoiser; FP8 Storage would re-cast
    that denoiser, which is not what the file is."""
    encoder_weight = torch.zeros(8, 4).to(torch.float8_e4m3fn)
    path = _qwen_image_checkpoint(
        tmp_path / "qwen_image_all_in_one.safetensors",
        torch.bfloat16,
        **{"text_encoders.qwen25_7b.transformer.model.layers.0.mlp.down_proj.weight": encoder_weight},
    )

    config = _identify(path)

    assert config.default_settings is None or config.default_settings.fp8_storage is None


def _diffusers_folder_with_float8(tmp_path: Path, weight_file: str | None) -> Path:
    folder = tmp_path / "sdxl-diffusers"
    shutil.copytree(_DIFFUSERS_FIXTURE, folder)
    if weight_file is not None:
        save_file({"layer.weight": torch.zeros(8, 4).to(torch.float8_e4m3fn)}, str(folder / weight_file))
    return folder


def test_a_denoiser_file_whose_header_is_not_a_json_object_does_not_fail_identification(tmp_path: Path) -> None:
    folder = _diffusers_folder_with_float8(tmp_path, None)
    header = b"[]"
    (folder / "unet" / "diffusion_pytorch_model.safetensors").write_bytes(len(header).to_bytes(8, "little") + header)

    result = ModelConfigFactory.from_model_on_disk(folder, allow_unknown=False)

    assert result.config is not None and result.config.type is ModelType.Main, result.details


@pytest.mark.parametrize(
    "weight_file, expected",
    [
        ("unet/diffusion_pytorch_model.safetensors", True),
        # The denoiser is what FP8 Storage casts; an FP8 text encoder beside a full-precision UNet does not count.
        ("text_encoder/model.safetensors", None),
        # Unreadable placeholder headers everywhere: nothing to go on, and no reason to fail identification.
        (None, None),
    ],
)
def test_a_diffusers_folder_is_judged_by_its_denoiser_weights(
    tmp_path: Path, weight_file: str | None, expected: bool | None
) -> None:
    folder = _diffusers_folder_with_float8(tmp_path, weight_file)

    result = ModelConfigFactory.from_model_on_disk(folder, allow_unknown=False)

    assert result.config is not None and result.config.type is ModelType.Main, result.details
    settings = result.config.default_settings
    assert (settings.fp8_storage if settings is not None else None) is expected


def test_an_install_setting_wins_over_detection_in_both_directions(tmp_path: Path) -> None:
    fp8_file = _qwen_image_checkpoint(tmp_path / "fp8.safetensors", torch.float8_e4m3fn)
    full_precision_file = _qwen_image_checkpoint(tmp_path / "bf16.safetensors", torch.bfloat16)

    kept_off = _identify(fp8_file, {"default_settings": {"fp8_storage": False}})
    turned_on = _identify(full_precision_file, {"default_settings": {"fp8_storage": True}})

    assert kept_off.default_settings is not None and kept_off.default_settings.fp8_storage is False
    assert turned_on.default_settings is not None and turned_on.default_settings.fp8_storage is True


def test_an_install_setting_keeps_the_architectures_other_defaults(tmp_path: Path) -> None:
    path = _qwen_image_checkpoint(tmp_path / "bf16.safetensors", torch.bfloat16)
    probed = _identify(path).default_settings

    overridden = _identify(path, {"default_settings": {"fp8_storage": True}}).default_settings

    assert probed is not None and overridden is not None
    assert overridden.model_dump(exclude={"fp8_storage"}) == probed.model_dump(exclude={"fp8_storage"})
