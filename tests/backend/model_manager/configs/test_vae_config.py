"""Tests for conservative Diffusers VAE identification."""

import json
from pathlib import Path

import pytest

from invokeai.backend.model_manager.configs.identification_utils import NotAMatchError
from invokeai.backend.model_manager.configs.vae import VAE_Diffusers_Config_Base
from invokeai.backend.model_manager.model_on_disk import ModelOnDisk
from invokeai.backend.model_manager.taxonomy import BaseModelType


@pytest.mark.parametrize(
    ("config", "name", "expected_base"),
    [
        (
            {"_class_name": "AutoencoderKL", "scaling_factor": 0.18215, "sample_size": 512},
            "vae",
            BaseModelType.StableDiffusion1,
        ),
        (
            {"_class_name": "AutoencoderKL", "scaling_factor": 0.13025, "sample_size": 1024},
            "vae",
            BaseModelType.StableDiffusionXL,
        ),
        (
            {"_class_name": "AutoencoderKL", "scaling_factor": 0.5, "sample_size": 768},
            "my-xl-vae",
            BaseModelType.StableDiffusionXL,
        ),
    ],
)
def test_diffusers_vae_known_base_detection(
    tmp_path: Path, config: dict, name: str, expected_base: BaseModelType
) -> None:
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")

    assert VAE_Diffusers_Config_Base._get_base_or_raise(ModelOnDisk(tmp_path), name) is expected_base


def test_unknown_diffusers_vae_is_not_assumed_to_be_sd1(tmp_path: Path) -> None:
    (tmp_path / "config.json").write_text(
        json.dumps({"_class_name": "AutoencoderKL", "scaling_factor": 0.5, "sample_size": 768}),
        encoding="utf-8",
    )

    with pytest.raises(NotAMatchError):
        VAE_Diffusers_Config_Base._get_base_or_raise(ModelOnDisk(tmp_path))
