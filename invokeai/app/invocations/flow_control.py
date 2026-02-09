# Copyright (c) 2024 Kyle Schouviller (https://github.com/kyle0654)

from invokeai.app.invocations.baseinvocation import (
    BaseInvocation,
    BaseInvocationOutput,
    FlowControlConfig,
    invocation,
    invocation_output,
)
from invokeai.app.invocations.fields import FieldDescriptions, InputField, OutputField
from invokeai.app.services.shared.invocation_context import InvocationContext


@invocation_output("if_output")
class IfInvocationOutput(BaseInvocationOutput):
    """Flow control outputs for the If invocation."""

    flow_control_source_true: bool = OutputField(
        default=False,
        title="True",
        description="Flow control output for the true branch.",
        ui_order=0,
    )
    flow_control_source_false: bool = OutputField(
        default=False,
        title="False",
        description="Flow control output for the false branch.",
        ui_order=1,
    )


@invocation(
    "if",
    title="If",
    tags=["logic", "flow", "control", "if"],
    category="logic",
    version="1.0.0",
    flow_control=FlowControlConfig(outgoing=False),
)
class IfInvocation(BaseInvocation):
    """Routes flow control to one of two branches based on a boolean condition."""

    condition: bool = InputField(default=False, description=FieldDescriptions.condition)

    def invoke(self, context: InvocationContext) -> IfInvocationOutput:
        return IfInvocationOutput(
            flow_control_source_true=self.condition,
            flow_control_source_false=not self.condition,
        )
