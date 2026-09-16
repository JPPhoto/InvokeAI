"""Identification of Comfy-Org's single-file Ideogram 4 transformers.

The two branches are key-for-key and shape-for-shape identical: only the file's `model_type`
metadata says which is which, and a swapped pair produces coherent images that ignore the prompt.

The quantization refusals raise `InvalidMatchError` rather than `NotAMatchError` on purpose, and
the distinction is the whole point of the test below: `NotAMatchError` is "not my kind of model"
and lets the file fall through to `Unknown_Config`, which would register a 9 GiB download as a
model record nothing can load.
"""

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import torch
from safetensors.torch import save_file

from invokeai.backend.model_manager.configs.identification_utils import InvalidMatchError, NotAMatchError
from invokeai.backend.model_manager.configs.main import Main_Checkpoint_Ideogram4_Config
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelFormat, ModelType

_REQUIRED_FIELDS = {
    "hash": "blake3:fakehash",
    "path": "/fake/models/ideogram4_fp8_scaled.safetensors",
    "file_size": 1000,
    "name": "ideogram4",
    "description": "test",
    "source": "test",
    "source_type": "path",
    "key": "test-key",
}


def _state_dict(**overrides: Any) -> dict[str, Any]:
    """The four keys the probe requires, as the released files carry them."""
    sd: dict[str, Any] = {
        "embed_image_indicator.weight": torch.zeros(2, 8, dtype=torch.bfloat16),
        "input_proj.weight": torch.zeros(8, 4, dtype=torch.bfloat16),
        "adaln_proj.weight": torch.zeros(4, 8, dtype=torch.bfloat16),
        "final_layer.linear.weight": torch.zeros(4, 8, dtype=torch.bfloat16),
        "layers.0.attention.qkv.weight": torch.zeros(24, 8, dtype=torch.bfloat16),
    }
    sd.update(overrides)
    return sd


def _mod(state_dict: dict[str, Any], *, metadata: dict[str, str] | None = None, name: str = "ideogram4.safetensors"):
    mod = MagicMock()
    mod.path = Path(f"/fake/{name}")
    mod.load_state_dict.return_value = state_dict
    mod.metadata.return_value = metadata or {}
    return mod


def _identify(mod: MagicMock, **override_fields: Any) -> Main_Checkpoint_Ideogram4_Config:
    with (
        patch("invokeai.backend.model_manager.configs.main.raise_if_not_file"),
        patch("invokeai.backend.model_manager.configs.main.raise_for_override_fields"),
    ):
        return Main_Checkpoint_Ideogram4_Config.from_model_on_disk(mod, {**_REQUIRED_FIELDS, **override_fields})


class TestBranchIdentification:
    @pytest.mark.parametrize(
        ("model_type", "expected"),
        [("ideogram4_cond", "conditional"), ("ideogram4_uncond", "unconditional")],
    )
    def test_reads_the_branch_from_file_metadata(self, model_type: str, expected: str) -> None:
        config = _identify(_mod(_state_dict(), metadata={"model_type": model_type}))

        assert config.base is BaseModelType.Ideogram4
        assert config.type is ModelType.Main
        assert config.format is ModelFormat.Checkpoint
        assert config.branch == expected

    def test_metadata_beats_a_misleading_filename(self) -> None:
        config = _identify(
            _mod(
                _state_dict(),
                metadata={"model_type": "ideogram4_cond"},
                name="ideogram4_unconditional_fp8_scaled.safetensors",
            )
        )

        assert config.branch == "conditional"

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("ideogram4_unconditional_fp8_scaled.safetensors", "unconditional"),
            ("Ideogram4_UNCONDITIONAL.safetensors", "unconditional"),
            # The metadata spells it "uncond", and a repack that drops the metadata is exactly the
            # kind of tool that would carry that spelling into the filename.
            ("ideogram4_uncond_fp8.safetensors", "unconditional"),
            ("ideogram4_fp8_scaled.safetensors", "conditional"),
        ],
    )
    def test_falls_back_to_the_filename_when_metadata_was_stripped(self, name: str, expected: str) -> None:
        config = _identify(_mod(_state_dict(), name=name))

        assert config.branch == expected

    def test_a_declaration_this_build_does_not_know_is_refused(self) -> None:
        """Not a fall-through to the filename.

        The loader node treats the recorded branch as authoritative *because* it came from the file.
        A future release tagged `ideogram4_5_cond` would otherwise install as one of these two
        branches and guide against the wrong model, with nothing in the log.
        """
        with pytest.raises(InvalidMatchError, match="ideogram4_5_cond"):
            _identify(_mod(_state_dict(), metadata={"model_type": "ideogram4_5_cond"}))

    def test_an_explicit_override_wins_over_both(self) -> None:
        # The config-level contract, not a user-facing remedy: nothing populates `branch` in
        # `build_common_fields`, so today this is only reachable from code. The error a user sees
        # names renaming and re-installing, which is what actually works.
        config = _identify(
            _mod(_state_dict(), metadata={"model_type": "ideogram4_cond"}),
            branch="unconditional",
        )

        assert config.branch == "unconditional"


class TestRefusals:
    def test_rejects_a_state_dict_from_another_architecture(self) -> None:
        with pytest.raises(NotAMatchError, match="Ideogram 4 transformer"):
            _identify(_mod({"double_blocks.0.img_attn.qkv.weight": torch.zeros(1)}))

    def test_rejects_a_partial_key_set(self) -> None:
        sd = _state_dict()
        del sd["embed_image_indicator.weight"]

        with pytest.raises(NotAMatchError, match="Ideogram 4 transformer"):
            _identify(_mod(sd))

    def test_rejects_the_nvfp4_repack(self) -> None:
        # The released file keeps `input_proj` in fp8 and packs only the block linears, so the
        # refusal cannot key on one tensor's dtype -- and a packed nvfp4 weight is uint8, the same
        # dtype as the `comfy_quant` markers that every repack (including the supported fp8 one)
        # carries. `weight_scale_2` is the signal only nvfp4 writes.
        sd = _state_dict(
            **{
                "layers.0.attention.qkv.weight": torch.zeros(24, 4, dtype=torch.uint8),
                "layers.0.attention.qkv.weight_scale_2": torch.zeros((), dtype=torch.float32),
            }
        )

        with pytest.raises(InvalidMatchError, match="nvfp4"):
            _identify(_mod(sd))

    def test_rejects_the_int8_repack(self) -> None:
        # As released: bf16 input projection, int8 block linears.
        sd = _state_dict(**{"layers.0.attention.qkv.weight": torch.zeros(24, 8, dtype=torch.int8)})

        with pytest.raises(InvalidMatchError, match="int8"):
            _identify(_mod(sd))

    def test_accepts_the_scaled_fp8_release(self) -> None:
        # The one quantized build this loader does handle: fp8 weight plus a per-tensor scale.
        sd = _state_dict(
            **{
                "input_proj.weight": torch.zeros(8, 4, dtype=torch.float8_e4m3fn),
                "input_proj.weight_scale": torch.zeros((), dtype=torch.float32),
            }
        )

        config = _identify(_mod(sd, metadata={"model_type": "ideogram4_cond"}))

        assert config.branch == "conditional"


class TestRefusalReachesTheInstaller:
    """The refusals must not be swallowed by the Unknown fallback.

    `ModelConfigFactory.from_model_on_disk` catches `NotAMatchError` per candidate class and, with
    `allow_unknown_models` on (the default), registers anything nothing matched as `Unknown_Config`.
    An `InvalidMatchError` wins over that: no record is written and the reason is what the installer
    reports.
    """

    @pytest.mark.parametrize(
        ("weight", "expected"),
        [
            (torch.zeros(24, 8, dtype=torch.int8), "int8"),
            (torch.zeros(24, 4, dtype=torch.uint8), "nvfp4"),
        ],
    )
    def test_an_unsupported_repack_is_not_registered_as_unknown(
        self, tmp_path: Path, weight: torch.Tensor, expected: str
    ) -> None:
        from invokeai.backend.model_manager.configs.factory import ModelConfigFactory
        from invokeai.backend.model_manager.model_on_disk import ModelOnDisk

        sd = _state_dict(**{"layers.0.attention.qkv.weight": weight})
        if expected == "nvfp4":
            sd["layers.0.attention.qkv.weight_scale_2"] = torch.zeros((), dtype=torch.float32)

        checkpoint = tmp_path / "ideogram4_repack.safetensors"
        save_file(sd, checkpoint, metadata={"model_type": "ideogram4_cond"})

        result = ModelConfigFactory.from_model_on_disk(ModelOnDisk(checkpoint), {}, allow_unknown=True)

        assert result.config is None, "an unsupported repack must not be registered at all"
        reasons = [str(detail) for detail in result.details.values() if isinstance(detail, InvalidMatchError)]
        assert any(expected in reason for reason in reasons), reasons
