from unittest.mock import Mock

import pytest

from invokeai.app.invocations.collections import CollectionConcatInvocation, CollectionZipInvocation


def test_collection_concat_preserves_left_then_right_order() -> None:
    invocation = CollectionConcatInvocation(id="concat", first=[1, 2], second=[3, 4])

    output = invocation.invoke(Mock())

    assert output.collection == [1, 2, 3, 4]


def test_collection_concat_handles_empty_inputs() -> None:
    invocation = CollectionConcatInvocation(id="concat", first=[], second=["value"])

    output = invocation.invoke(Mock())

    assert output.collection == ["value"]


def test_collection_concat_does_not_mutate_input_collections() -> None:
    first = ["left"]
    second = ["right"]
    invocation = CollectionConcatInvocation(id="concat", first=first, second=second)

    output = invocation.invoke(Mock())
    output.collection.append("changed")

    assert first == ["left"]
    assert second == ["right"]


def test_collection_zip_preserves_positional_order_as_pairs() -> None:
    invocation = CollectionZipInvocation(id="zip", first=[1, 2], second=["a", "b"])

    output = invocation.invoke(Mock())

    assert output.collection == [[1, "a"], [2, "b"]]


def test_collection_zip_rejects_unequal_input_lengths() -> None:
    invocation = CollectionZipInvocation(id="zip", first=[1], second=["a", "b"])

    with pytest.raises(ValueError, match="same length"):
        invocation.invoke(Mock())


def test_collection_zip_handles_empty_inputs() -> None:
    invocation = CollectionZipInvocation(id="zip", first=[], second=[])

    output = invocation.invoke(Mock())

    assert output.collection == []


def test_collection_zip_does_not_mutate_input_collections() -> None:
    first = ["left"]
    second = ["right"]
    invocation = CollectionZipInvocation(id="zip", first=first, second=second)

    output = invocation.invoke(Mock())
    output.collection.append(["changed", "value"])

    assert first == ["left"]
    assert second == ["right"]
