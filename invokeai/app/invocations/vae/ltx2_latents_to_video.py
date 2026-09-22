"""Decode LTX-2 video and audio latents and write an MP4 with an AAC soundtrack."""

import tempfile
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import torch

from invokeai.app.invocations.baseinvocation import BaseInvocation, Classification, invocation
from invokeai.app.invocations.fields import (
    FieldDescriptions,
    Input,
    InputField,
    LatentsField,
    LTX2AudioConditioningField,
    WithBoard,
    WithMetadata,
)
from invokeai.app.invocations.model import LTX2VocoderField, VAEField
from invokeai.app.invocations.primitives import VideoOutput
from invokeai.app.invocations.vae.wan_latents_to_video import _write_video_frames
from invokeai.app.services.session_processor.session_processor_common import CanceledException
from invokeai.app.services.shared.invocation_context import InvocationContext
from invokeai.app.util.video_audio import extract_audio_pcm
from invokeai.app.util.video_encoding import make_mp4_writer, write_stereo_wav
from invokeai.backend.ltx2.constants import (
    LTX2_DEFAULT_FPS,
    LTX2_DEFAULT_TEMPORAL_TILE,
    LTX2_DEFAULT_TILE_SIZE,
)
from invokeai.backend.ltx2.video_decoding import decode_audio_latents, decode_video_latents
from invokeai.backend.util.devices import TorchDevice
from invokeai.backend.util.vae_working_memory import (
    estimate_audio_working_memory_ltx2,
    estimate_vae_working_memory_ltx2,
)


def _iter_decoded_frames(decoded: torch.Tensor) -> Iterator[np.ndarray]:
    """Yield uint8 HWC frames from a [C, T, H, W] clip already in [0, 1]."""
    for index in range(decoded.shape[1]):
        frame = decoded[:, index].permute(1, 2, 0)
        yield (255.0 * frame).round().clamp(0, 255).byte().numpy()


@invocation(
    "ltx2_latents_to_video",
    title="Latents to Video - LTX-2",
    tags=["latents", "video", "audio", "vae", "l2v", "ltx", "ltx2"],
    category="latents",
    version="1.1.0",
    classification=Classification.Prototype,
)
class LTX2LatentsToVideoInvocation(BaseInvocation, WithMetadata, WithBoard):
    """Decodes LTX-2 video and audio latents into an MP4 with an AAC stereo track."""

    video_latents: LatentsField = InputField(description=FieldDescriptions.latents, input=Input.Connection)
    source_audio: LTX2AudioConditioningField | None = InputField(
        default=None,
        description="The soundtrack this clip was generated for. When set, it is muxed in as it was "
        "supplied rather than the generated audio being decoded.",
        input=Input.Connection,
        title="Source Audio",
    )
    audio_latents: LatentsField | None = InputField(
        default=None,
        description="Packed audio latents from the denoise node. Omit for a silent video.",
        input=Input.Connection,
    )
    vae: VAEField = InputField(description=FieldDescriptions.vae, input=Input.Connection, title="Video VAE")
    audio_vae: VAEField | None = InputField(
        default=None, description=FieldDescriptions.ltx2_audio_vae, input=Input.Connection, title="Audio VAE"
    )
    vocoder: LTX2VocoderField | None = InputField(
        default=None, description=FieldDescriptions.ltx2_vocoder, input=Input.Connection, title="Vocoder"
    )
    fps: float = InputField(
        default=LTX2_DEFAULT_FPS, ge=1, le=120, description="Frames per second of the output video."
    )
    tile_size: int = InputField(
        default=LTX2_DEFAULT_TILE_SIZE,
        ge=64,
        description="Spatial decode tile, in output pixels. Smaller tiles need less VRAM and take longer.",
    )
    temporal_tile: int = InputField(
        default=LTX2_DEFAULT_TEMPORAL_TILE,
        ge=8,
        description="Temporal decode tile, in output frames. Smaller tiles need less VRAM and take longer.",
    )

    @torch.no_grad()
    def invoke(self, context: InvocationContext) -> VideoOutput:
        decoded = self._decode_video(context)
        if context.util.is_canceled():
            raise CanceledException

        num_frames = decoded.shape[1]
        height, width = decoded.shape[2:]
        duration = num_frames / float(self.fps)

        # The soundtrack is decoded and trimmed before the writer opens: the WAV has to exist, and
        # match the video's duration, when the muxing writer is constructed.
        # Audio-to-video conditions on a soundtrack the user already has, so the output carries that
        # recording rather than a vocoder's reconstruction of the latents it was encoded to. The
        # generated audio latents are still produced -- the model denoises both streams -- but
        # decoding them here would replace the original with a lossy copy of itself.
        if self.source_audio is not None:
            wav_path = self._extract_source_audio_to_wav(context, duration)
        elif self.audio_latents is not None:
            wav_path = self._decode_audio_to_wav(context, duration)
        else:
            wav_path = None

        tmp = tempfile.NamedTemporaryFile(prefix="invokeai_ltx2_video_", suffix=".mp4", delete=False)
        tmp.close()
        tmp_path = Path(tmp.name)
        try:
            context.logger.info(
                f"Encoding MP4: {num_frames} frames @ {self.fps} fps ({duration:.2f}s) at {width}x{height}"
                + (" + AAC stereo" if wav_path is not None else "")
            )
            context.util.signal_progress(f"Encoding MP4 ({num_frames} frames @ {self.fps} fps)")
            writer = make_mp4_writer(tmp_path, float(self.fps), audio_path=wav_path)
            try:
                _write_video_frames(writer, _iter_decoded_frames(decoded), context.util.is_canceled)
            finally:
                writer.close()
            del decoded
            TorchDevice.empty_cache()

            video_dto = context.videos.save(
                source_path=tmp_path,
                width=int(width),
                height=int(height),
                duration=duration,
                fps=float(self.fps),
            )
            context.logger.info(f"Saved video: {video_dto.video_name}")
            return VideoOutput.build(video_dto)
        finally:
            tmp_path.unlink(missing_ok=True)
            if wav_path is not None:
                wav_path.unlink(missing_ok=True)

    def _decode_video(self, context: InvocationContext) -> torch.Tensor:
        latents = context.tensors.load(self.video_latents.latents_name)
        if latents.ndim != 5:
            raise ValueError(f"LTX-2 video latents must be 5D [B, C, T, H, W]; got {tuple(latents.shape)}.")

        vae_info = context.models.load(self.vae.vae)
        _, _, latent_frames, latent_height, latent_width = latents.shape
        spatial = int(vae_info.model.spatial_compression_ratio)
        temporal = int(vae_info.model.temporal_compression_ratio)
        pixel_frames = (latent_frames - 1) * temporal + 1
        pixel_height, pixel_width = latent_height * spatial, latent_width * spatial

        estimated_working_memory = estimate_vae_working_memory_ltx2(
            operation="decode",
            vae=vae_info.model,
            pixel_height=pixel_height,
            pixel_width=pixel_width,
            pixel_frames=pixel_frames,
            tile_size=self.tile_size,
            temporal_tile=self.temporal_tile,
        )
        with vae_info.model_on_device(working_mem_bytes=estimated_working_memory) as (_, vae):
            context.logger.info(
                f"Running LTX-2 VAE decode: {latent_frames} latent frames -> {pixel_frames} pixel frames "
                f"at {pixel_width}x{pixel_height}"
            )
            context.util.signal_progress("Running the LTX-2 video VAE decode")
            TorchDevice.empty_cache()
            decoded = decode_video_latents(
                vae,
                latents,
                tile_size=self.tile_size,
                temporal_tile=self.temporal_tile,
                is_canceled=context.util.is_canceled,
            )
        TorchDevice.empty_cache()
        return decoded

    def _extract_source_audio_to_wav(self, context: InvocationContext, video_duration_s: float) -> Path:
        """The conditioning clip's own soundtrack, trimmed or padded to the generated duration.

        The generation's length is the soundtrack's, snapped down to the frame grid, so the clip is
        normally a little longer than the video; the tail beyond the last frame is dropped.
        """
        assert self.source_audio is not None
        source = context.videos.get_path(self.source_audio.source_video_name)
        decoded = extract_audio_pcm(source, float_pcm=True)

        if decoded is None:
            raise ValueError(f"'{self.source_audio.source_video_name}' no longer has an audio track to mux back in.")

        samples, sample_rate = decoded
        wanted = int(round(video_duration_s * sample_rate))
        if samples.shape[1] > wanted:
            samples = samples[:, :wanted]
        elif samples.shape[1] < wanted:
            samples = np.pad(samples, ((0, 0), (0, wanted - samples.shape[1])))

        wav = tempfile.NamedTemporaryFile(prefix="invokeai_ltx2_source_audio_", suffix=".wav", delete=False)
        wav.close()
        wav_path = Path(wav.name)
        try:
            write_stereo_wav(wav_path, samples, sample_rate)
        except Exception:
            wav_path.unlink(missing_ok=True)
            raise
        return wav_path

    def _decode_audio_to_wav(self, context: InvocationContext, video_duration_s: float) -> Path:
        assert self.audio_latents is not None
        if self.audio_vae is None or self.vocoder is None:
            raise ValueError(
                "Audio latents are wired but the Audio VAE and Vocoder are not. Connect both from the "
                "LTX-2 model loader, or disconnect the audio latents for a silent video."
            )

        latents = context.tensors.load(self.audio_latents.latents_name)
        if latents.ndim != 3:
            raise ValueError(f"LTX-2 audio latents must be packed [1, L, 128]; got {tuple(latents.shape)}.")

        # None of the three audio stages is tiled, so the whole soundtrack is decoded in one pass
        # and the reservation has to cover its length. Both models are locked for it: the vocoder
        # consumes the audio VAE's output directly.
        audio_memory = estimate_audio_working_memory_ltx2(int(latents.shape[1]))
        audio_vae_info = context.models.load(self.audio_vae.vae)
        vocoder_info = context.models.load(self.vocoder.vocoder)
        with (
            audio_vae_info.model_on_device(working_mem_bytes=audio_memory) as (_, audio_vae),
            vocoder_info.model_on_device(working_mem_bytes=audio_memory) as (_, vocoder),
        ):
            context.util.signal_progress("Running the LTX-2 audio VAE decode")
            waveform = decode_audio_latents(audio_vae, vocoder, latents, is_canceled=context.util.is_canceled)
            sample_rate = int(vocoder.config.output_sampling_rate)

        if waveform.shape[0] != 2:
            raise ValueError(f"The LTX-2 vocoder produced {waveform.shape[0]} channels; expected stereo.")

        # Trim (or zero-pad: the 25-latents/s grid does not divide every duration exactly) to the
        # video's length, so the mux needs no -shortest and cannot leave a trailing silence.
        max_samples = int(round(video_duration_s * sample_rate))
        waveform = waveform[:, :max_samples]
        if waveform.shape[1] < max_samples:
            waveform = torch.nn.functional.pad(waveform, (0, max_samples - waveform.shape[1]))

        wav = tempfile.NamedTemporaryFile(prefix="invokeai_ltx2_audio_", suffix=".wav", delete=False)
        wav.close()
        wav_path = Path(wav.name)
        try:
            write_stereo_wav(wav_path, waveform.numpy(), sample_rate)
        except Exception:
            wav_path.unlink(missing_ok=True)
            raise
        return wav_path
