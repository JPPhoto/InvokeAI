"""Canvas resolution for LTX-2 from a source image's aspect ratio."""

from typing import Literal

from invokeai.app.invocations.baseinvocation import BaseInvocation, Classification, invocation
from invokeai.app.invocations.fields import InputField
from invokeai.app.invocations.ideal_size import IdealSizeOutput
from invokeai.app.services.shared.invocation_context import InvocationContext
from invokeai.backend.ltx2.packing import resolve_canvas

LTX2TargetResolution = Literal["512p", "704p", "768p"]

LTX2_TARGET_RESOLUTION_LABELS: dict[str, str] = {
    "512p": "512p (short edge 512 - fastest)",
    "704p": "704p (short edge 704)",
    "768p": "768p (short edge 768 - sharpest, slowest)",
}

_SHORT_EDGES: dict[str, int] = {"512p": 512, "704p": 704, "768p": 768}


@invocation(
    "ltx2_ideal_dimensions",
    title="LTX-2 Ideal Dimensions",
    tags=["ltx", "ltx2", "video", "dimensions", "math"],
    category="video",
    version="1.0.0",
    classification=Classification.Prototype,
)
class LTX2IdealDimensionsInvocation(BaseInvocation):
    """Ideal LTX-2 dimensions for a source image's aspect ratio.

    The chosen preset pins the canvas's *short* edge and the long edge follows the source's aspect
    ratio, each axis rounded to a multiple of 32 (the video VAE's spatial compression). Only the
    ratio of the inputs matters. Wire the outputs into the width and height of both the image
    conditioning and the denoise node, which must share one canvas.

    Cost grows with the token count, which is the canvas area over 1024: 768p is about 2.2x the
    work of 512p at the same length.
    """

    width: int = InputField(default=1024, gt=0, description="Source image width in pixels.")
    height: int = InputField(default=1024, gt=0, description="Source image height in pixels.")
    target_resolution: LTX2TargetResolution = InputField(
        default="704p",
        description="Which short edge to pin the canvas to.",
        ui_choice_labels=LTX2_TARGET_RESOLUTION_LABELS,
    )

    def invoke(self, context: InvocationContext) -> IdealSizeOutput:
        height, width = resolve_canvas(float(self.width), float(self.height), _SHORT_EDGES[self.target_resolution])
        return IdealSizeOutput(width=width, height=height)
