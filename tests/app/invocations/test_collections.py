from unittest.mock import Mock

from invokeai.app.invocations.collections import CollectionConcatInvocation


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
