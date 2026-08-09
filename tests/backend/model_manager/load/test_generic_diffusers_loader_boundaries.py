"""Tests for malformed dynamic Diffusers loader configuration."""

import json
from pathlib import Path

import pytest

from invokeai.backend.model_manager.load.model_loaders.generic_diffusers import GenericDiffusersLoader


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"_class_name": "NotARealDiffusersClass"},
        {"architectures": ["NotARealTransformersClass"]},
        {"_class_name": 123},
    ],
)
def test_generic_diffusers_loader_rejects_invalid_class_metadata(tmp_path: Path, config: dict) -> None:
    (tmp_path / "config.json").write_text(json.dumps(config), encoding="utf-8")
    loader = object.__new__(GenericDiffusersLoader)

    with pytest.raises(ValueError, match="class|config|model"):
        loader.get_hf_load_class(tmp_path)
