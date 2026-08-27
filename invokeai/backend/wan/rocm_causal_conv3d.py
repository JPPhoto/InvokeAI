"""ROCm workaround: decompose WanCausalConv3d into per-temporal-tap conv2d calls.

MIOpen (ROCm's cuDNN equivalent) has no implicit-GEMM 3D-convolution kernels for
the shapes used by the Wan VAE on RDNA3 — it falls back to ``Im3d2Col``, which
materializes every 3x3x3 patch into a matrix before a GEMM. Profiling a Wan 2.1
VAE decode on a W7900 showed Im3d2Col consuming 61% of GPU time, and neither
dtype changes nor ``cudnn.benchmark`` kernel search helped (all configs within
±7%). MIOpen's *2D* convolutions are well optimized, and a stride-1 kT x kH x kW
conv3d is exactly the sum of kT conv2d taps over shifted temporal slices, so this
module rebinds ``WanCausalConv3d.forward`` to that decomposition.

Measured on a W7900 (832x480, 3 latent frames, bf16): 81.6s -> 1.71s (~48x),
matching NVIDIA wall-clock for the same decode. Numerics: identical math up to
floating-point summation order — max abs error vs ``F.conv3d`` is ~1e-6 in fp32;
a full bf16 VAE decode differs by at most ~3/255 in pixel space with 0.1% of
pixels off by more than 1/255 (bf16 accumulation noise, visually imperceptible).

The patch is class-level and idempotent, applied only when torch is a ROCm/HIP
build. It covers every ``AutoencoderKLWan`` consumer (Wan decode/encode nodes,
ref-image encoding, Anima's VAE) regardless of which loader constructed it.
"""

import torch
import torch.nn.functional as F

_SENTINEL = "_invokeai_rocm_conv2d_decomposition"


def _decomposed_conv3d(module: torch.nn.Conv3d, x: torch.Tensor) -> torch.Tensor:
    """``F.conv3d(x, module.weight, module.bias)`` for stride-1/dilation-1/groups-1
    convs, computed as kT batched conv2d taps. ``x`` must already be padded."""
    b, c, t, h, w = x.shape
    k_t = module.weight.shape[2]
    t_out = t - k_t + 1
    # Every tensor this decomposition hands to a kernel (or returns to the caller) MUST be
    # standard-contiguous. The naive expressions produce three legal-but-exotic strided views
    # that old MIOpen tolerated (it copied internally) but the MIOpen in torch's rocm7.2 wheels
    # consumes directly and mis-addresses, corrupting rows whenever H != W (horizontal
    # line/tearing artifacts in decoded images):
    #   1. the tap input — at B=1 (every real decode) the reshape is satisfiable as a zero-copy
    #      view whose channel stride (T*H*W) exceeds its batch stride (H*W);
    #   2. the tap weight — weight[:, :, k] is a strided view over the temporal dim for every
    #      kT > 1 conv;
    #   3. the returned activation — reshape+transpose yields a transposed view consumed by
    #      downstream norm/upsample kernels.
    # The explicit copies cost a small fraction of the conv itself.
    out = None
    for k in range(k_t):
        xs = x[:, :, k : k + t_out].transpose(1, 2).reshape(b * t_out, c, h, w).contiguous()
        o = F.conv2d(xs, module.weight[:, :, k].contiguous(), None)
        out = o if out is None else out + o
    assert out is not None
    if module.bias is not None:
        out = out + module.bias.view(1, -1, 1, 1)
    oh, ow = out.shape[-2:]
    return out.reshape(b, t_out, -1, oh, ow).transpose(1, 2).contiguous()


def _decomposed_forward(self, x: torch.Tensor, cache_x: torch.Tensor | None = None) -> torch.Tensor:
    # Causal-padding / feature-cache handling copied verbatim from
    # diffusers.models.autoencoders.autoencoder_kl_wan.WanCausalConv3d.forward.
    padding = list(self._padding)
    if cache_x is not None and self._padding[4] > 0:
        cache_x = cache_x.to(x.device)
        x = torch.cat([cache_x, x], dim=2)
        padding[4] -= cache_x.shape[2]
    x = F.pad(x, padding)
    if self.stride != (1, 1, 1) or self.dilation != (1, 1, 1) or self.groups != 1:
        # Not worth decomposing (and stride couples the temporal taps) — these
        # only occur on encoder downsample convs, which are a minority of calls.
        return F.conv3d(x, self.weight, self.bias, self.stride, (0, 0, 0), self.dilation, self.groups)
    return _decomposed_conv3d(self, x)


def _patch_wan_causal_conv3d() -> None:
    """Rebind WanCausalConv3d.forward to the conv2d decomposition (idempotent)."""
    from diffusers.models.autoencoders.autoencoder_kl_wan import WanCausalConv3d

    if getattr(WanCausalConv3d, _SENTINEL, False):
        return
    WanCausalConv3d.forward = _decomposed_forward
    setattr(WanCausalConv3d, _SENTINEL, True)


def patch_wan_causal_conv3d_for_rocm() -> None:
    """Apply the conv2d decomposition on ROCm builds; no-op elsewhere.

    Call from any loader that constructs an ``AutoencoderKLWan``. cuDNN has real
    implicit-GEMM conv3d kernels, so CUDA builds keep the stock path.
    """
    if torch.version.hip is None:
        return
    _patch_wan_causal_conv3d()
