"""LTX-2 flow-matching schedule and step.

Two schedules, one step. The dev checkpoint samples a resolution-shifted linear schedule
deterministically; the guidance-distilled checkpoint samples eight fixed noise levels ancestrally.
Both are stepped by :func:`flow_step`, which is the rectified-flow ancestral Euler step of
``ltx_core.components.diffusion_steps.EulerAncestralDiffusionStep`` and reduces exactly to the
deterministic Euler step at ``eta=0``.

The step is written in x0 space (the space the guidance combine works in) rather than in velocity
space. The two are the same update: a velocity prediction is ``v = (x - x0) / sigma``, and the
flow-match Euler step ``x + (sigma_next - sigma) * v`` expands to
``(sigma_next / sigma) * x + (1 - sigma_next / sigma) * x0`` -- the deterministic branch below.
Converting back and forth around the guidance combine, as the reference pipelines do, would only
add two divisions by a sigma that is already the step's own ratio.
"""

import math

import torch

from invokeai.backend.ltx2.constants import (
    LTX2_BASE_SEQ_LEN,
    LTX2_BASE_SHIFT,
    LTX2_DISTILLED_SIGMAS,
    LTX2_MAX_SEQ_LEN,
    LTX2_MAX_SHIFT,
)

# The last sampled noise level every shifted schedule is stretched onto. Not cosmetic: at the
# max-shift anchor the raw schedule's final sigma is 0.21, and without the stretch the run would
# stop a fifth of the way from clean. Both upstream implementations apply it --
# ``LTX2Scheduler(stretch=True, terminal=0.1)`` in ltx-core, and ``shift_terminal: 0.1`` in the
# released diffusers scheduler config, which
# ``FlowMatchEulerDiscreteScheduler.stretch_shift_to_terminal`` reads.
LTX2_SHIFT_TERMINAL = 0.1


def calculate_shift(video_seq_len: int) -> float:
    """The schedule's ``mu``, interpolated from the token count and held at the anchors outside them.

    The clamp is the whole point. The line is fitted between 1024 and 4096 tokens, and every canvas
    this architecture offers is past its top: a 1248x704x121 clip is 13728 tokens, where the
    unclamped line gives mu 5.5 and the resulting schedule spends 29 of 30 steps above sigma 0.54
    before covering 0.54 -> 0.1 in one. Held at 2.05, the schedule is the released pipeline's
    exactly -- ltx-core's ``LTX2Scheduler`` is called with no latent, so it always takes the
    max-shift anchor, and the diffusers port's own default operating point is inside the range.
    """
    slope = (LTX2_MAX_SHIFT - LTX2_BASE_SHIFT) / (LTX2_MAX_SEQ_LEN - LTX2_BASE_SEQ_LEN)
    shift = video_seq_len * slope + LTX2_BASE_SHIFT - slope * LTX2_BASE_SEQ_LEN

    return min(max(shift, LTX2_BASE_SHIFT), LTX2_MAX_SHIFT)


def build_sigmas(*, distilled: bool, num_steps: int, video_seq_len: int) -> torch.Tensor:
    """The noise levels to sample, terminal 0 included, as ``[num_steps + 1]`` float32 on the CPU.

    ``num_steps`` is ignored for the distilled schedule, whose eight levels are a property of the
    checkpoint's distillation rather than a sampling budget; the caller reports that to the user.
    """
    if distilled:
        return torch.tensor((*LTX2_DISTILLED_SIGMAS, 0.0), dtype=torch.float32)

    if num_steps < 1:
        raise ValueError(f"LTX-2 needs at least one step; got {num_steps}.")

    # Built in float64 and narrowed once at the end. The shift divides mu by itself at sigma 1,
    # which in float32 is the exact mu over a rounded one -- the schedule would not start at 1.
    sigmas = torch.linspace(1.0, 1.0 / num_steps, num_steps, dtype=torch.float64)
    mu = math.exp(calculate_shift(video_seq_len))
    sigmas = mu / (mu + (1.0 / sigmas - 1.0))

    # A single step is already the terminal one, and its `1 - sigma` is 0: there is nothing to
    # stretch onto and the scale factor would be a division by zero.
    if num_steps > 1:
        one_minus = 1.0 - sigmas
        sigmas = 1.0 - one_minus * (1.0 - LTX2_SHIFT_TERMINAL) / one_minus[-1]

    return torch.cat([sigmas, torch.zeros(1, dtype=torch.float64)]).to(torch.float32)


def flow_step(
    sample: torch.Tensor,
    denoised: torch.Tensor,
    sigmas: torch.Tensor,
    index: int,
    *,
    eta: float = 0.0,
    s_noise: float = 1.0,
    noise: torch.Tensor | None = None,
) -> torch.Tensor:
    """Advance one sampling step, from ``sigmas[index]`` to ``sigmas[index + 1]``.

    ``denoised`` is the x0 prediction. With ``eta > 0`` the step advances deterministically to an
    intermediate ``sigma_down`` and renoises back up, rescaling the signal component by
    ``alpha_next / alpha_down`` (with ``alpha = 1 - sigma``, the rectified-flow parameterization)
    so the transition stays variance preserving. ``eta = 0`` is the plain Euler step and needs no
    noise. The terminal level returns the prediction itself.
    """
    sigma = sigmas[index].to(torch.float32)
    sigma_next = sigmas[index + 1].to(torch.float32)
    x = sample.to(torch.float32)
    x0 = denoised.to(torch.float32)

    if sigma_next == 0:
        return x0

    down_ratio = 1.0 + (sigma_next / sigma - 1.0) * eta
    sigma_down = sigma_next * down_ratio

    ratio = sigma_down / sigma
    x_next = ratio * x + (1.0 - ratio) * x0

    if eta > 0:
        if noise is None:
            raise ValueError("An ancestral LTX-2 step (eta > 0) needs a noise tensor.")
        alpha_next = 1.0 - sigma_next
        alpha_down = 1.0 - sigma_down
        renoise = (sigma_next**2 - sigma_down**2 * alpha_next**2 / alpha_down**2).clamp(min=0) ** 0.5
        x_next = (alpha_next / alpha_down) * x_next + noise.to(torch.float32) * s_noise * renoise

    return x_next
