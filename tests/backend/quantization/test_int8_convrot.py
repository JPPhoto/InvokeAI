"""Tests for the Comfy int8_tensorwise(+convrot) dequantization runtime.

The Hadamard/rotation semantics were verified against Comfy-Org/comfy-quants and
comfy-kitchen: ``W_rot = grouped(W) @ H^T`` with the normalized regular Hadamard.
These tests quantize a known weight the same way and pin that our dequantization
recovers it, so the loader can never silently mis-rotate.
"""

import sys

import pytest
import torch

from invokeai.backend.model_manager.taxonomy import ModelFormat
from invokeai.backend.quantization.int8_convrot import (
    CONVROT_GROUP_SIZE,
    Int8ConvrotLinear,
    build_regular_hadamard,
    dequantize_convrot_weight,
    extract_int8_convrot_markers,
    parse_comfy_quant_marker,
    requires_sidecar_patching,
)


def _quantize_reference(w: torch.Tensor, convrot: bool) -> tuple[torch.Tensor, torch.Tensor]:
    """Reference quantizer mirroring comfy-quants: optional grouped rotation by H^T,
    then symmetric per-output-channel int8."""
    if convrot:
        out_f, in_f = w.shape
        h = build_regular_hadamard(CONVROT_GROUP_SIZE, dtype=w.dtype)
        w = (w.view(out_f, in_f // CONVROT_GROUP_SIZE, CONVROT_GROUP_SIZE) @ h.T).view(out_f, in_f)
    scale = w.abs().amax(dim=1, keepdim=True) / 127.0
    q = torch.clamp(torch.round(w / scale), -128, 127).to(torch.int8)
    return q, scale.to(torch.float32)


def test_regular_hadamard_is_symmetric_orthonormal() -> None:
    h = build_regular_hadamard(CONVROT_GROUP_SIZE)
    assert torch.equal(h, h.T)
    eye = h @ h
    assert torch.allclose(eye, torch.eye(CONVROT_GROUP_SIZE), atol=1e-5)


def test_dequantize_recovers_unrotated_weight() -> None:
    """Quantize with rotation, dequantize with derotation: the result must match the
    original weight to within int8 quantization error (and be much closer than the
    still-rotated weight is)."""
    torch.manual_seed(0)
    w = torch.randn(64, 2 * CONVROT_GROUP_SIZE)
    q, scale = _quantize_reference(w, convrot=True)

    recovered = dequantize_convrot_weight(q, scale, convrot=True, dtype=torch.float32)
    quant_err = (recovered - w).abs().max().item()
    # Per-element error is scale/2 in the ROTATED domain; derotation is orthonormal so the
    # l2 norm carries over exactly, but the max-abs bound is only statistical (each element
    # mixes 256 errors at +-1/16) - allow 2x the per-row scale.
    assert quant_err < 2 * scale.max().item()

    still_rotated = q.float() * scale
    assert (still_rotated - w).abs().max() > 10 * quant_err


def test_dequantize_without_convrot() -> None:
    torch.manual_seed(1)
    w = torch.randn(32, CONVROT_GROUP_SIZE)
    q, scale = _quantize_reference(w, convrot=False)
    recovered = dequantize_convrot_weight(q, scale, convrot=False, dtype=torch.float32)
    assert (recovered - w).abs().max().item() < scale.max().item()


def test_int8_convrot_linear_matches_dequantized_f_linear() -> None:
    torch.manual_seed(2)
    w = torch.randn(48, CONVROT_GROUP_SIZE)
    q, scale = _quantize_reference(w, convrot=True)
    lin = Int8ConvrotLinear(q, scale, convrot=True)

    x = torch.randn(5, CONVROT_GROUP_SIZE)
    ref = torch.nn.functional.linear(x, dequantize_convrot_weight(q, scale, convrot=True, dtype=torch.float32))
    got = lin(x)
    assert torch.allclose(ref, got, atol=1e-5)

    # End-to-end sanity: output approximates the full-precision linear.
    full = torch.nn.functional.linear(x, w)
    assert (got - full).abs().max().item() < 1.0


def test_int8_convrot_linear_state_dict_contract() -> None:
    """Persistent buffers must be named exactly `weight` / `weight_scale` (+ optional `bias`)
    so the converted checkpoint's keys load directly and strict load_state_dict holds; the
    Hadamard is computed, never loaded, but must still move with the module."""
    torch.manual_seed(3)
    w = torch.randn(16, CONVROT_GROUP_SIZE)
    q, scale = _quantize_reference(w, convrot=True)
    bias = torch.randn(16)
    lin = Int8ConvrotLinear(q, scale, convrot=True, bias=bias)
    assert set(lin.state_dict().keys()) == {"weight", "weight_scale", "bias"}
    assert {n for n, _ in lin.named_buffers()} == {"weight", "weight_scale", "hadamard", "bias"}
    assert lin.state_dict()["weight"].dtype == torch.int8


def test_parse_comfy_quant_marker() -> None:
    blob = torch.frombuffer(
        b'{"format": "int8_tensorwise", "convrot": true, "convrot_groupsize": 256}', dtype=torch.uint8
    ).clone()
    marker = parse_comfy_quant_marker(blob)
    assert marker == {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}


@pytest.mark.skipif(
    sys.platform == "win32",
    # torch's CPU bf16 kernels dispatch on the host ISA, and the Windows CI fleet is mixed
    # hardware: on some runners this exact call crashes the interpreter with an illegal
    # instruction (0xC000001D) inside the dequant matmul. Same commit passes on a re-run with a
    # different runner, so it is the machine, not the code. The bf16 contract below is still
    # covered on Linux and macOS, and the dequant path only runs on a GPU in practice.
    reason="torch CPU bf16 matmul faults on some Windows CI runners (illegal instruction)",
)
def test_int8_convrot_linear_bf16_path_tracks_fp32_reference() -> None:
    """Dequant + derotation run in the input dtype; on bf16 the scale-multiply rounding must
    stay within ~2% relative of the exact fp32 dequantization path."""
    torch.manual_seed(4)
    w = torch.randn(48, 2 * CONVROT_GROUP_SIZE)
    q, scale = _quantize_reference(w, convrot=True)
    lin = Int8ConvrotLinear(q, scale, convrot=True)

    x = torch.randn(5, 2 * CONVROT_GROUP_SIZE)
    ref = torch.nn.functional.linear(x, dequantize_convrot_weight(q, scale, convrot=True, dtype=torch.float32))
    got = lin(x.to(torch.bfloat16)).to(torch.float32)
    rel_err = (got - ref).abs().max() / ref.abs().max()
    assert rel_err < 0.02, f"bf16 dequant path diverges from fp32 reference: rel_err={rel_err:.4f}"


class TestThePerOutputChannelScaleLayout:
    """`check_int8_scale_layout` accepts `[out]` as well as `[out, 1]`, so both have to decode the
    same. Broadcasting aligns trailing dimensions, so `weight[out, in] * scale[out]` scales along
    the *input* axis: silently wrong for a square weight -- 0.82 correlation against the intended
    result, a model that loads and generates -- and a bare size mismatch for anything else."""

    @pytest.mark.parametrize(("out_features", "in_features"), [(16, 16), (32, 16), (16, 32)])
    def test_a_one_dimensional_scale_decodes_like_a_column_one(self, out_features, in_features):
        torch.manual_seed(0)
        weight = torch.randint(-127, 127, (out_features, in_features), dtype=torch.int8)
        flat = torch.rand(out_features) * 0.01 + 0.001

        from_flat = dequantize_convrot_weight(weight, flat, convrot=False, dtype=torch.float32)
        from_column = dequantize_convrot_weight(weight, flat.reshape(-1, 1), convrot=False, dtype=torch.float32)

        assert torch.equal(from_flat, from_column)

    def test_a_per_tensor_scale_is_left_alone(self):
        weight = torch.ones(8, 4, dtype=torch.int8)
        scalar = torch.tensor(0.5)

        decoded = dequantize_convrot_weight(weight, scalar, convrot=False, dtype=torch.float32)

        assert torch.allclose(decoded, torch.full((8, 4), 0.5))

    def test_the_module_decodes_a_one_dimensional_scale_the_same_way(self):
        torch.manual_seed(0)
        weight = torch.randint(-127, 127, (16, 16), dtype=torch.int8)
        flat = torch.rand(16) * 0.01 + 0.001

        flat_module = Int8ConvrotLinear(weight, flat, convrot=False)
        column_module = Int8ConvrotLinear(weight, flat.reshape(-1, 1), convrot=False)
        probe = torch.randn(3, 16)

        assert torch.allclose(flat_module(probe), column_module(probe))


class TestAMalformedMarkerIsALostHintNotAFailedLoad:
    """This runs over every marker in the file before the loader knows which format it is reading,
    so a blob belonging to some other scheme decides whether an fp8 checkpoint loads at all. Comfy
    pads these to a fixed width with NUL bytes -- documented and stripped by the fp8 reader -- and a
    strict parse turned that into a JSONDecodeError out of the middle of a load."""

    @staticmethod
    def _blob(raw: bytes) -> torch.Tensor:
        # `frombuffer` rejects a zero-length buffer, and an empty marker is a case worth covering.
        if not raw:
            return torch.empty(0, dtype=torch.uint8)
        return torch.frombuffer(bytearray(raw), dtype=torch.uint8).clone()

    @pytest.mark.parametrize(
        ("label", "raw"),
        [
            ("nul padded", b'{"format":"float8_e4m3fn"}' + bytes([0]) * 8),
            ("invalid utf-8", b'{"format":"' + bytes([0xFF, 0xFE]) + b'"}'),
            ("not an object", b"[1, 2, 3]"),
            ("empty", b""),
        ],
    )
    def test_it_survives_a_blob_it_cannot_parse(self, label, raw):
        sd = {"lin.weight": torch.zeros(4, 4), "lin.comfy_quant": self._blob(raw)}

        markers = extract_int8_convrot_markers(sd)

        assert markers == {}
        # Left in place: it belongs to whichever path does understand it.
        assert "lin.comfy_quant" in sd

    def test_a_nul_padded_int8_marker_is_still_read(self):
        raw = b'{"format":"int8_tensorwise"}' + bytes([0]) * 16
        sd = {"lin.weight": torch.zeros(4, 4, dtype=torch.int8), "lin.comfy_quant": self._blob(raw)}

        markers = extract_int8_convrot_markers(sd)

        assert list(markers) == ["lin"]
        assert "lin.comfy_quant" not in sd


class TestWhetherLoraNeedsASidecar:
    """Asked of the loaded module tree, not the config. An `Int8ConvrotLinear` holds its weight as a
    buffer, so the patcher's own fallbacks -- which iterate `module.parameters()` -- find nothing and
    choose direct patching on a module with no patchable weights."""

    @staticmethod
    def _model(int8: bool) -> torch.nn.Module:
        model = torch.nn.Module()
        if int8:
            model.blk = Int8ConvrotLinear(torch.zeros(8, 8, dtype=torch.int8), torch.ones(8, 1), convrot=False)
        else:
            model.blk = torch.nn.Linear(8, 8)
        return model

    def test_an_int8_resident_checkpoint_needs_one(self):
        assert requires_sidecar_patching(self._model(int8=True), ModelFormat.Checkpoint) is True

    def test_a_plain_checkpoint_does_not(self):
        assert requires_sidecar_patching(self._model(int8=False), ModelFormat.Checkpoint) is False

    @pytest.mark.parametrize("fmt", [ModelFormat.GGUFQuantized, ModelFormat.SDNQQuantized])
    def test_a_format_that_is_quantized_by_definition_needs_one(self, fmt):
        assert requires_sidecar_patching(self._model(int8=False), fmt) is True
