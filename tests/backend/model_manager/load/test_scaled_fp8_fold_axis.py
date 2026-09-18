"""Per-call-site guards for the scale axis used when folding a scaled-fp8 weight.

A per-output-channel `weight_scale` is 1-D of length `out_features`, and `(out, in) * (out,)`
broadcasts on the *last* axis — so a bare multiply scales input channels instead of output
channels. That is a shape error on a non-square weight (loud) and a silently wrong weight on a
square one (not loud at all). Every call site below used to do its own multiply; they now all go
through `expand_weight_scale`.

`test_fp8_scaled.py` covers the helper itself. These pin the call sites, so re-inlining a local
loop at any of them fails a test rather than passing CI — which is how three copies of the
expansion accumulated, two of them wrong. The expected weights are written out literally rather
than derived from `expand_weight_scale`, because an expectation computed by the code under test
cannot tell a correct fold from a fold that is wrong in the same way.
"""

from unittest.mock import MagicMock

import pytest
import torch

from invokeai.backend.model_manager.load.model_loaders.comfyui_state_dict_utils import (
    _dequantize_comfyui_fp8,
)
from invokeai.backend.model_manager.load.model_loaders.flux import Flux2CheckpointModel
from invokeai.backend.model_manager.load.model_loaders.mistral_encoder import _drop_quantization_metadata
from invokeai.backend.model_manager.load.model_loaders.z_image import _fold_comfy_scaled_weights
from invokeai.backend.quantization.fp8_scaled import (
    WEIGHT_SCALE_SUFFIXES,
)


def _per_channel_case(out_features: int = 4, in_features: int = 2):
    """A non-square weight with a per-output-channel scale: rows 0..n-1 scaled by 1..n."""
    weight = torch.ones(out_features, in_features).to(torch.float8_e4m3fn)
    scale = torch.arange(1, out_features + 1, dtype=torch.float32)
    expected = torch.arange(1, out_features + 1, dtype=torch.bfloat16).reshape(-1, 1).expand(-1, in_features)
    return weight, scale, expected


class TestMistralEncoderFold:
    def test_per_channel_scale_multiplies_rows(self) -> None:
        weight, scale, expected = _per_channel_case()
        sd = {"layer.weight": weight, "layer.weight_scale": scale}

        _drop_quantization_metadata(sd, MagicMock(), target_dtype=torch.bfloat16)

        assert torch.equal(sd["layer.weight"], expected)
        assert "layer.weight_scale" not in sd

    def test_square_weight_is_not_silently_transposed(self) -> None:
        """The dangerous case: a square weight broadcasts happily on the wrong axis."""
        sd = {
            "layer.weight": torch.ones(3, 3).to(torch.float8_e4m3fn),
            "layer.weight_scale": torch.tensor([1.0, 2.0, 3.0]),
        }

        _drop_quantization_metadata(sd, MagicMock(), target_dtype=torch.bfloat16)

        rows = torch.tensor([[1.0, 1.0, 1.0], [2.0, 2.0, 2.0], [3.0, 3.0, 3.0]], dtype=torch.bfloat16)
        assert torch.equal(sd["layer.weight"], rows), "scale must vary down the rows, not across them"


class TestZImageQwen3EncoderFold:
    """The Z-Image Qwen3 encoder's single-file loader folds the same way."""

    def _fold(self, sd: dict, dtype: torch.dtype = torch.bfloat16) -> dict:
        # The real call site. It was a loop inside `_load_from_singlefile` -- unreachable without a
        # checkpoint and a transformers model -- so it was extracted; re-inlining it as a local
        # multiply fails these tests instead of passing CI.
        _fold_comfy_scaled_weights(sd, dtype)
        return sd

    def test_per_channel_scale_multiplies_rows(self) -> None:
        weight, scale, expected = _per_channel_case()
        sd = self._fold({"layer.weight": weight, "layer.weight_scale": scale})
        assert torch.equal(sd["layer.weight"], expected)

    def test_non_square_weight_does_not_raise(self) -> None:
        weight, scale, _ = _per_channel_case(out_features=6, in_features=2)
        sd = self._fold({"layer.weight": weight, "layer.weight_scale": scale})
        assert sd["layer.weight"].shape == (6, 2)

    def test_block_wise_scale_is_expanded_rather_than_rejected(self) -> None:
        sd = self._fold(
            {
                "layer.weight": torch.ones(4, 2).to(torch.float8_e4m3fn),
                "layer.weight_scale": torch.tensor([[1.0], [2.0]]),  # one entry per 2-row block
            }
        )
        assert torch.equal(
            sd["layer.weight"],
            torch.tensor([[1.0, 1.0], [1.0, 1.0], [2.0, 2.0], [2.0, 2.0]], dtype=torch.bfloat16),
        )

    def test_a_scale_matching_neither_layout_is_reported(self) -> None:
        with pytest.raises(ValueError, match="neither per-tensor nor per-output-channel"):
            self._fold(
                {
                    "layer.weight": torch.ones(4, 2).to(torch.float8_e4m3fn),
                    "layer.weight_scale": torch.full((3,), 2.0),
                }
            )


class TestSharedComfyFold:
    """`_dequantize_comfyui_fp8`, the copy the Wan (`wan.py:511`) and Qwen-Image
    (`qwen_image.py:514`) loaders reach. Its local loop compared `scale.shape[dim] !=
    weight.shape[dim]`, so a per-output-channel scale -- whose length already equals the row count
    -- was expanded by nothing and left to broadcasting."""

    def _fold(self, weight: torch.Tensor, scale: torch.Tensor, spelling: str = ".weight_scale") -> torch.Tensor:
        sd = {"layer.weight": weight, f"layer{spelling}": scale}
        assert _dequantize_comfyui_fp8(sd, torch.float32) == 1, "the fold did not recognise the pair"
        return sd["layer.weight"]

    @pytest.mark.parametrize("spelling", WEIGHT_SCALE_SUFFIXES)
    def test_both_spellings_of_the_weight_scale_fold_the_same_way(self, spelling: str) -> None:
        """The Qwen2.5-VL producer writes `.scale_weight`; the weight key is derived from whichever
        suffix matched, and getting that derivation wrong for one spelling leaves those layers
        un-scaled with their orphaned scale then stripped, so nothing is logged."""
        folded = self._fold(torch.ones(4, 3), torch.tensor([1.0, 2.0, 3.0, 4.0]), spelling)

        assert torch.equal(folded, torch.tensor([1.0, 2.0, 3.0, 4.0]).reshape(4, 1).expand(4, 3))

    def test_a_square_weight_is_scaled_down_its_rows(self) -> None:
        """The silent case. Columns and rows both "work"; only one is right."""
        weight = torch.tensor([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0]])

        folded = self._fold(weight, torch.tensor([2.0, 4.0, 8.0]))

        assert torch.equal(folded, torch.tensor([[2.0, 4.0, 6.0], [16.0, 20.0, 24.0], [56.0, 64.0, 72.0]]))

    def test_a_non_square_weight_folds_instead_of_raising(self) -> None:
        """The loud half of the same defect: broadcasting cannot align 4 against 3 at all."""
        folded = self._fold(torch.ones(4, 3), torch.tensor([1.0, 2.0, 3.0, 4.0]))

        assert torch.equal(folded, torch.tensor([1.0, 2.0, 3.0, 4.0]).reshape(4, 1).expand(4, 3))

    def test_a_block_wise_scale_is_still_expanded(self) -> None:
        """What the local loop existed for, and what the delegation must not lose."""
        folded = self._fold(torch.ones(4, 2), torch.tensor([[1.0], [2.0]]))

        assert torch.equal(folded, torch.tensor([[1.0, 1.0], [1.0, 1.0], [2.0, 2.0], [2.0, 2.0]]))

    def test_a_scale_matching_neither_layout_names_the_layer(self) -> None:
        """ "2 entries but 3 output channels" is not a diagnosis on a checkpoint with a thousand
        Linears; which layer is."""
        with pytest.raises(ValueError, match=r"layer\.weight: fp8 weight_scale has 2 entries"):
            self._fold(torch.ones(3, 3), torch.tensor([2.0, 4.0]))

    def test_a_single_entry_scale_of_any_rank_stays_per_tensor(self) -> None:
        """`(1, 1, 1)` is one number, so it is per-tensor whatever its rank -- but returned as-is it
        back-aligns and the product comes out `(1, out, in)`."""
        folded = self._fold(torch.ones(3, 2), torch.full((1, 1, 1), 2.0))

        assert torch.equal(folded, torch.full((3, 2), 2.0))


class TestFlux2Fold:
    """FLUX.2's own copy (`flux.py`). It is unreachable at its one call site -- extraction takes
    every scale first -- but it is a method anyone can call, it carried the same defect, and the
    ordering that makes it dead is pinned in `test_flux2_int8_convrot_loader.py` rather than here."""

    def _fold(self, weight: torch.Tensor, scale: torch.Tensor) -> torch.Tensor:
        sd = {"layer.weight": weight, "layer.weight_scale": scale}
        return Flux2CheckpointModel._dequantize_fp8_weights(None, sd)["layer.weight"]

    def test_a_square_weight_is_scaled_down_its_rows(self) -> None:
        weight = torch.ones(3, 3).to(torch.float8_e4m3fn)

        folded = self._fold(weight, torch.tensor([1.0, 2.0, 4.0]))

        rows = torch.tensor([[1.0, 1.0, 1.0], [2.0, 2.0, 2.0], [4.0, 4.0, 4.0]], dtype=torch.bfloat16)
        assert torch.equal(folded, rows), "scale must vary down the rows, not across them"

    def test_the_result_is_bfloat16_rather_than_float32(self) -> None:
        """The multiply runs in float32 for precision but must not leave the whole model there --
        holding every dequantized weight as float32 was the dominant cold-load spike."""
        folded = self._fold(torch.ones(4, 2).to(torch.float8_e4m3fn), torch.tensor([1.0, 2.0, 3.0, 4.0]))

        assert folded.dtype is torch.bfloat16
