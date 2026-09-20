"""LTX-2 latent geometry: what the canvas rules allow and how latents pack."""

import pytest
import torch

from invokeai.backend.ltx2.packing import (
    audio_latent_count,
    base_canvas,
    latent_frame_count,
    pack_audio_latents,
    pack_video_latents,
    require_patch_geometry,
    resolve_canvas,
    snap_num_frames,
    unpack_audio_latents,
    unpack_video_latents,
    validate_canvas,
    validate_num_frames,
    video_sequence_length,
)


def test_a_packed_row_is_the_channel_vector_at_its_latent_position() -> None:
    """The packing is what places a token in space, so its order is a contract with the model.

    Rows run frame-major, then row-major within a frame; each row is that position's channels. The
    expectation is built by indexing the 5D tensor, not by rerunning the permutation.
    """
    latents = torch.randn(1, 4, 3, 2, 5)
    packed = pack_video_latents(latents)
    assert packed.shape == (1, 3 * 2 * 5, 4)

    for index, (frame, row, column) in enumerate((f, h, w) for f in range(3) for h in range(2) for w in range(5)):
        assert torch.equal(packed[0, index], latents[0, :, frame, row, column])


def test_unpacking_video_latents_restores_the_original_tensor() -> None:
    latents = torch.randn(1, 8, 4, 3, 6)
    assert torch.equal(unpack_video_latents(pack_video_latents(latents), 4, 3, 6), latents)


def test_an_audio_row_is_one_latent_frame_with_mel_bins_inside_channels() -> None:
    latents = torch.randn(1, 3, 4, 2)
    packed = pack_audio_latents(latents)
    assert packed.shape == (1, 4, 6)
    for frame in range(4):
        assert torch.equal(packed[0, frame], latents[0, :, frame, :].reshape(-1))
    assert torch.equal(unpack_audio_latents(packed, mel_bins=2), latents)


@pytest.mark.parametrize(("num_frames", "expected"), [(1, 1), (9, 2), (17, 3), (121, 16), (241, 31)])
def test_the_latent_frame_count_follows_the_causal_vae_grouping(num_frames: int, expected: int) -> None:
    """The first frame is encoded alone and every further group of eight shares a latent frame."""
    assert latent_frame_count(num_frames) == expected


def test_the_sequence_length_is_the_latent_grid(num_frames: int = 121) -> None:
    assert video_sequence_length(num_frames, 704, 1248) == 16 * 22 * 39


@pytest.mark.parametrize(("num_frames", "fps", "expected"), [(121, 24.0, 126), (9, 24.0, 9), (25, 25.0, 25)])
def test_the_audio_latent_count_covers_the_clip_duration(num_frames: int, fps: float, expected: int) -> None:
    """25 audio latents a second, from the clip's duration rather than its frame count."""
    assert audio_latent_count(num_frames, fps) == expected


@pytest.mark.parametrize("num_frames", [0, 2, 8, 10, 120])
def test_a_frame_count_off_the_grid_is_refused_with_the_nearest_valid_one(num_frames: int) -> None:
    with pytest.raises(ValueError, match="8n \\+ 1"):
        validate_num_frames(num_frames)


@pytest.mark.parametrize(("requested", "expected"), [(1, 1), (3, 1), (5, 9), (8, 9), (100, 97), (122, 121)])
def test_snapping_a_frame_count_rounds_a_tie_up(requested: int, expected: int) -> None:
    """A 5-frame request is equidistant from 1 and 9; a single still frame is not what it meant."""
    assert snap_num_frames(requested) == expected
    validate_num_frames(snap_num_frames(requested))


@pytest.mark.parametrize("size", [(704, 1250), (700, 1248), (0, 1248)])
def test_a_canvas_off_the_32_grid_is_refused(size: tuple[int, int]) -> None:
    with pytest.raises(ValueError):
        validate_canvas(*size)


@pytest.mark.parametrize(
    ("source", "short_edge", "expected"),
    [
        ((1920, 1080), 704, (704, 1248)),
        ((1080, 1920), 704, (1248, 704)),
        ((512, 512), 768, (768, 768)),
        ((4000, 3000), 512, (512, 672)),
    ],
)
def test_the_canvas_pins_the_short_edge_and_stays_on_the_grid(
    source: tuple[int, int], short_edge: int, expected: tuple[int, int]
) -> None:
    height, width = resolve_canvas(source[0], source[1], short_edge)
    assert (height, width) == expected
    validate_canvas(height, width)
    assert min(height, width) == short_edge


def test_a_transformer_that_patches_differently_is_refused_before_anything_is_packed() -> None:
    """Every packing here assumes 1x1x1 patching; a 2x2 checkpoint would silently mis-shape."""
    from types import SimpleNamespace

    require_patch_geometry(SimpleNamespace(patch_size=1, patch_size_t=1))
    with pytest.raises(ValueError, match="patches the latent grid"):
        require_patch_geometry(SimpleNamespace(patch_size=2, patch_size_t=1))


@pytest.mark.parametrize(
    ("aspect", "expected"),
    [((16, 9), (1792, 1024)), ((1, 1), (1024, 1024)), ((9, 16), (1024, 1792))],
)
def test_a_two_stage_canvas_lands_where_halving_it_stays_on_the_grid(
    aspect: tuple[int, int], expected: tuple[int, int]
) -> None:
    """The 64 grid exists for one reason: the base pass runs at half the canvas, and half of a
    32-grid number is not always one."""
    height, width = resolve_canvas(aspect[0], aspect[1], 1024, multiple=64)

    assert (width, height) == expected
    base_height, base_width = base_canvas(height, width)
    assert (base_width * 2, base_height * 2) == (width, height)
    assert base_width % 32 == 0 and base_height % 32 == 0


def test_a_canvas_that_cannot_be_halved_onto_the_grid_is_refused() -> None:
    # 1248x704 is a legitimate single-stage canvas, and its *width* is what refuses: 1248 % 64 is
    # 32, so halving it gives 624, which is not on the 32 grid. (704 halves to 352, which is.)
    with pytest.raises(ValueError, match="multiple of 64"):
        base_canvas(704, 1248)


def test_a_grid_that_is_not_a_multiple_of_the_canvas_one_is_refused() -> None:
    with pytest.raises(ValueError, match="canvas grid"):
        resolve_canvas(16, 9, 1024, multiple=48)
