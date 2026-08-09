"""Tests for InvokeAI-format IP-Adapter probing."""

from pathlib import Path

import pytest
import torch

from invokeai.backend.model_manager.configs.factory import ModelConfigFactory
from invokeai.backend.model_manager.configs.ip_adapter import IPAdapter_InvokeAI_SD1_Config


class _FakeModelOnDisk:
    def __init__(self, path: Path):
        self.path = path
        self.name = path.name

    def hash(self) -> str:
        return "test-hash"

    def size(self) -> int:
        return sum(file.stat().st_size for file in self.path.rglob("*"))

    def load_state_dict(self) -> dict[str, dict[str, torch.Tensor]]:
        return {"ip_adapter": {"1.to_k_ip.weight": torch.empty(1, 768)}}


def test_invokeai_ip_adapter_probe_reads_image_encoder_id(tmp_path: Path) -> None:
    (tmp_path / "ip_adapter.bin").touch()
    (tmp_path / "image_encoder.txt").write_text("InvokeAI/ip_adapter_sd_image_encoder\n", encoding="utf-8")

    result = ModelConfigFactory.from_model_on_disk(_FakeModelOnDisk(tmp_path), allow_unknown=False)

    assert isinstance(result.config, IPAdapter_InvokeAI_SD1_Config)
    assert result.config.image_encoder_model_id == "InvokeAI/ip_adapter_sd_image_encoder"


@pytest.mark.parametrize(
    "metadata",
    ["InvokeAI/ip_adapter_sd_image_encoder\n", "  InvokeAI/ip_adapter_sd_image_encoder  \r\n"],
)
def test_invokeai_ip_adapter_probe_normalizes_image_encoder_metadata(tmp_path: Path, metadata: str) -> None:
    (tmp_path / "ip_adapter.bin").touch()
    (tmp_path / "image_encoder.txt").write_text(metadata, encoding="utf-8")

    result = ModelConfigFactory.from_model_on_disk(_FakeModelOnDisk(tmp_path), allow_unknown=False)

    assert isinstance(result.config, IPAdapter_InvokeAI_SD1_Config)
    assert result.config.image_encoder_model_id == "InvokeAI/ip_adapter_sd_image_encoder"
