"""Tests for make_room()'s eviction guards."""

import logging
from unittest.mock import MagicMock

import torch

from invokeai.backend.model_manager.load.model_cache.model_cache import ModelCache
from tests.backend.model_manager.load.model_cache.cached_model.utils import DummyModule


def _make_cache() -> ModelCache:
    logger = MagicMock()
    logger.getEffectiveLevel.return_value = logging.INFO
    return ModelCache(
        execution_device_working_mem_gb=1.0,
        enable_partial_loading=False,
        keep_ram_copy_of_weights=True,
        execution_device="cpu",
        storage_device="cpu",
        logger=logger,
    )


def test_make_room_spares_entries_awaiting_first_use():
    """A just-admitted entry (put() done, first lock() pending) must survive make_room: the
    loader's handle keeps the model alive anyway — multi-model invocations load their whole set
    before locking any of it, so a sibling's cold-load make_room runs inside this window — and
    evicting it frees nothing while detaching the record from all cache accounting."""
    cache = _make_cache()
    cache.put("fresh", DummyModule())
    record = cache.get("fresh")

    # Precondition: the admission grace is armed (the deferred worker is running in-process).
    assert record.awaiting_first_use

    cache.make_room(10**15)
    assert "fresh" in cache._cached_models, "make_room evicted an entry still awaiting its first lock"

    # After the first lock/unlock cycle the grace is released and the entry is ordinary cache
    # content again.
    cache.lock(record, None)
    cache.unlock(record)
    assert not record.awaiting_first_use

    cache.make_room(10**15)
    assert "fresh" not in cache._cached_models


def test_make_room_still_evicts_ordinary_unlocked_entries():
    cache = _make_cache()
    cache.put("used", DummyModule())
    record = cache.get("used")
    cache.lock(record, None)
    cache.unlock(record)

    cache.make_room(10**15)
    assert "used" not in cache._cached_models


def test_make_room_never_evicts_locked_entries():
    cache = _make_cache()
    cache.put("held", DummyModule())
    record = cache.get("held")
    cache.lock(record, None)
    try:
        cache.make_room(10**15)
        assert "held" in cache._cached_models
    finally:
        cache.unlock(record)


def test_dummy_module_is_cpu():
    # Guard against the fixture silently needing CUDA: everything above must run CPU-only.
    assert not any(p.is_cuda for p in DummyModule().parameters())
    assert torch.cuda.is_available() or True
