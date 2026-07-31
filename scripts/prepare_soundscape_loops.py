#!/usr/bin/env python3
"""Prepare the approved Slow Pulse and Deep Focus source WAVs as pure loops."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np


SAMPLE_RATE = 44_100
BPM = 148.0
BARS = 88
RNG_SEED = 5150


def slow_pulse_frame_count(sample_rate: int) -> int:
    return round(BARS * 4 * 60 / BPM * sample_rate)


def library_loop_frame_counts(sample_rate: int) -> dict[str, int]:
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f'approved frame counts require {SAMPLE_RATE} Hz audio')
    return {
        'deep-focus': 4_941_792,
        'lofi-hip-hop': 3_175_200,
        'quiet-piano': 5_456_052,
        'organic-drift': 2_822_400,
        'still-air': 5_996_468,
        'rain-room': 3_969_000,
        'slow-pulse': slow_pulse_frame_count(sample_rate),
    }


def read_pcm16(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), 'rb') as source:
        if source.getsampwidth() != 2:
            raise ValueError(f'{path} must use 16-bit PCM')
        channels = source.getnchannels()
        sample_rate = source.getframerate()
        frames = source.getnframes()
        raw = source.readframes(frames)

    audio = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    return audio.reshape(-1, channels), sample_rate


def write_pcm16(path: Path, audio: np.ndarray, sample_rate: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clipped = np.clip(audio, -1.0, 1.0 - 1.0 / 32768.0)
    pcm = np.round(clipped * 32768.0).astype('<i2')
    with wave.open(str(path), 'wb') as output:
        output.setnchannels(audio.shape[1])
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(pcm.tobytes())


def pcm_format(path: Path) -> dict[str, int]:
    with wave.open(str(path), 'rb') as source:
        return {
            'sample_rate': source.getframerate(),
            'bits_per_sample': source.getsampwidth() * 8,
            'channels': source.getnchannels(),
            'frames': source.getnframes(),
        }


def equal_power_wrapped_loop(audio: np.ndarray, overlap_frames: int) -> np.ndarray:
    if overlap_frames <= 0 or overlap_frames * 2 >= len(audio):
        raise ValueError('overlap must be positive and shorter than half the source')

    phase = np.arange(overlap_frames, dtype=np.float64) / overlap_frames
    fade_out = np.cos(phase * math.pi / 2.0).astype(np.float32)[:, None]
    fade_in = np.sin(phase * math.pi / 2.0).astype(np.float32)[:, None]
    wrapped = audio[-overlap_frames:] * fade_out + audio[:overlap_frames] * fade_in
    return np.concatenate((wrapped, audio[overlap_frames:-overlap_frames]), axis=0)


def _add_event(bus: np.ndarray, signal: np.ndarray, start_frame: int, pan: float = 0.0) -> None:
    if start_frame >= len(bus):
        return
    stop = min(start_frame + len(signal), len(bus))
    event = signal[: stop - start_frame]
    left = math.sqrt((1.0 - pan) / 2.0)
    right = math.sqrt((1.0 + pan) / 2.0)
    bus[start_frame:stop, 0] += event * left
    bus[start_frame:stop, 1] += event * right


def _kick(sample_rate: int, strength: float = 1.0) -> np.ndarray:
    frames = round(0.32 * sample_rate)
    time = np.arange(frames, dtype=np.float64) / sample_rate
    frequency = 46.0 + 36.0 * np.exp(-time / 0.045)
    phase = 2.0 * math.pi * np.cumsum(frequency) / sample_rate
    envelope = (1.0 - np.exp(-time / 0.003)) * np.exp(-time / 0.115)
    return (0.23 * strength * np.sin(phase) * envelope).astype(np.float32)


def _backbeat(sample_rate: int, rng: np.random.Generator) -> np.ndarray:
    frames = round(0.24 * sample_rate)
    time = np.arange(frames, dtype=np.float64) / sample_rate
    noise = rng.standard_normal(frames).astype(np.float32)
    high = np.empty_like(noise)
    high[0] = noise[0]
    high[1:] = noise[1:] - 0.92 * noise[:-1]
    high /= max(float(np.max(np.abs(high))), 1e-6)
    noise_envelope = (1.0 - np.exp(-time / 0.002)) * np.exp(-time / 0.065)
    body_envelope = (1.0 - np.exp(-time / 0.004)) * np.exp(-time / 0.105)
    body = np.sin(2.0 * math.pi * 185.0 * time)
    return (0.052 * high * noise_envelope + 0.040 * body * body_envelope).astype(np.float32)


def _hat(sample_rate: int, rng: np.random.Generator, strength: float) -> np.ndarray:
    frames = round(0.072 * sample_rate)
    time = np.arange(frames, dtype=np.float64) / sample_rate
    noise = rng.standard_normal(frames).astype(np.float32)
    high = np.empty_like(noise)
    high[:2] = noise[:2]
    high[2:] = noise[2:] - 2.0 * noise[1:-1] + noise[:-2]
    high /= max(float(np.max(np.abs(high))), 1e-6)
    envelope = (1.0 - np.exp(-time / 0.0008)) * np.exp(-time / 0.021)
    return (0.024 * strength * high * envelope).astype(np.float32)


def _bass_note(sample_rate: int, duration: float, frequency: float) -> np.ndarray:
    frames = round(duration * sample_rate)
    time = np.arange(frames, dtype=np.float64) / sample_rate
    attack = np.minimum(time / 0.08, 1.0)
    release = np.minimum((duration - time) / 0.18, 1.0)
    envelope = np.clip(attack * release, 0.0, 1.0)
    body = np.sin(2.0 * math.pi * frequency * time)
    body += 0.18 * np.sin(2.0 * math.pi * 2.0 * frequency * time)
    return (0.030 * body * envelope).astype(np.float32)


def synthesize_slow_pulse(frames: int, sample_rate: int) -> np.ndarray:
    rng = np.random.default_rng(RNG_SEED)
    bus = np.zeros((frames, 2), dtype=np.float32)
    beat_frames = sample_rate * 60.0 / BPM

    for bar in range(BARS):
        bar_start = bar * 4 * beat_frames
        if bar_start >= frames:
            break
        _add_event(bus, _kick(sample_rate), round(bar_start))
        _add_event(bus, _backbeat(sample_rate, rng), round(bar_start + 2 * beat_frames), 0.04)

        if bar % 2 == 0:
            _add_event(bus, _kick(sample_rate, 0.48), round(bar_start + 3.25 * beat_frames), -0.03)
        else:
            _add_event(bus, _kick(sample_rate, 0.38), round(bar_start + 1.75 * beat_frames), 0.03)

        for eighth in range(8):
            beat = eighth * 0.5 + (0.075 if eighth % 2 else 0.0)
            strength = 0.56 if eighth % 2 == 0 else 0.78
            if bar % 8 == 7 and eighth >= 6:
                strength *= 0.55
            pan = -0.18 if eighth % 2 == 0 else 0.18
            _add_event(bus, _hat(sample_rate, rng, strength), round(bar_start + beat * beat_frames), pan)

        phrase_bar = bar % 8
        frequency = 73.416 if phrase_bar == 3 else 82.407 if phrase_bar == 7 else 49.0
        note_duration = 4 * beat_frames / sample_rate
        _add_event(bus, _bass_note(sample_rate, note_duration, frequency), round(bar_start))

    return bus


def seam_excerpt(
    audio: np.ndarray,
    sample_rate: int,
    before: float = 8.0,
    after: float = 12.0,
) -> np.ndarray:
    before_frames = round(before * sample_rate)
    after_frames = round(after * sample_rate)
    return np.concatenate((audio[-before_frames:], audio[:after_frames]), axis=0)


def _loudness(path: Path) -> tuple[float, float]:
    result = subprocess.run(
        [
            'ffmpeg',
            '-hide_banner',
            '-nostats',
            '-i',
            str(path),
            '-af',
            'loudnorm=I=-23:LRA=7:TP=-2:print_format=json',
            '-f',
            'null',
            '-',
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    match = re.search(r'\{\s*"input_i".*?\}', result.stderr, re.DOTALL)
    if not match:
        raise RuntimeError(f'could not measure loudness for {path}')
    report = json.loads(match.group(0))
    return float(report['input_i']), float(report['input_tp'])


def _normalize_static(audio: np.ndarray, scratch: Path) -> np.ndarray:
    write_pcm16(scratch, audio, SAMPLE_RATE)
    integrated, true_peak = _loudness(scratch)
    gain_db = min(-23.0 - integrated, -2.0 - true_peak)
    return audio * (10.0 ** (gain_db / 20.0))


def _convert_to_pcm(source: Path, output: Path) -> None:
    subprocess.run(
        [
            'ffmpeg',
            '-y',
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            str(source),
            '-ar',
            str(SAMPLE_RATE),
            '-c:a',
            'pcm_s16le',
            str(output),
        ],
        check=True,
    )


def prepare_slow_pulse(source: Path) -> np.ndarray:
    target_frames = slow_pulse_frame_count(SAMPLE_RATE)
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        stretched = temporary / 'slow-pulse-bed.wav'
        subprocess.run(
            [
                'ffmpeg',
                '-y',
                '-hide_banner',
                '-loglevel',
                'error',
                '-i',
                str(source),
                '-af',
                'atempo=1.024956605715',
                '-ar',
                str(SAMPLE_RATE),
                '-c:a',
                'pcm_s16le',
                str(stretched),
            ],
            check=True,
        )
        bed, sample_rate = read_pcm16(stretched)
        if sample_rate != SAMPLE_RATE or len(bed) <= target_frames:
            raise ValueError('Slow Pulse source did not produce the expected wrapped bed')
        bed = equal_power_wrapped_loop(bed, len(bed) - target_frames)
        mixed = bed + synthesize_slow_pulse(target_frames, SAMPLE_RATE)
        return _normalize_static(mixed, temporary / 'slow-pulse-level-check.wav')


def prepare_deep_focus(source: Path) -> np.ndarray:
    audio, sample_rate = read_pcm16(source)
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f'Deep Focus must use {SAMPLE_RATE} Hz PCM')
    looped = equal_power_wrapped_loop(audio, 8 * SAMPLE_RATE)
    with tempfile.TemporaryDirectory() as directory:
        scratch = Path(directory) / 'deep-focus-level-check.wav'
        return _normalize_static(looped, scratch)


def prepare_lofi_hip_hop(source: Path) -> np.ndarray:
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        converted = temporary / 'lofi-hip-hop.wav'
        _convert_to_pcm(source, converted)
        audio, sample_rate = read_pcm16(converted)
        if sample_rate != SAMPLE_RATE:
            raise ValueError(f'Lo-Fi Hip Hop must use {SAMPLE_RATE} Hz PCM')
        start = round(6.8 * SAMPLE_RATE)
        duration = 72 * SAMPLE_RATE
        overlap = 3 * SAMPLE_RATE
        region = audio[start:start + duration + overlap]
        if len(region) != duration + overlap:
            raise ValueError('Lo-Fi Hip Hop source is shorter than its approved loop region')
        looped = equal_power_wrapped_loop(region, overlap)
        return _normalize_static(looped, temporary / 'lofi-hip-hop-level-check.wav')


def prepare_quiet_piano(source: Path) -> np.ndarray:
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        converted = temporary / 'quiet-piano.wav'
        _convert_to_pcm(source, converted)
        audio, sample_rate = read_pcm16(converted)
        if sample_rate != SAMPLE_RATE:
            raise ValueError(f'Quiet Piano must use {SAMPLE_RATE} Hz PCM')
        looped = equal_power_wrapped_loop(audio, 8 * SAMPLE_RATE)
        return _normalize_static(looped, temporary / 'quiet-piano-level-check.wav')


def prepare_still_air(source: Path) -> np.ndarray:
    with tempfile.TemporaryDirectory() as directory:
        temporary = Path(directory)
        converted = temporary / 'still-air.wav'
        _convert_to_pcm(source, converted)
        audio, sample_rate = read_pcm16(converted)
        if sample_rate != SAMPLE_RATE:
            raise ValueError(f'Still Air must use {SAMPLE_RATE} Hz PCM')
        looped = equal_power_wrapped_loop(audio, SAMPLE_RATE)
        return _normalize_static(looped, temporary / 'still-air-level-check.wav')


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def _describe(label: str, path: Path) -> None:
    format_info = pcm_format(path)
    integrated, true_peak = _loudness(path)
    duration = format_info['frames'] / format_info['sample_rate']
    print(
        f'{label}: {duration:.6f}s, {format_info["sample_rate"]} Hz, '
        f'{format_info["bits_per_sample"]}-bit, {integrated:.2f} LUFS, '
        f'{true_peak:.2f} dBTP, sha256={_sha256(path)}'
    )


def _output_path(directory: Path, name: str, force: bool) -> Path:
    path = directory / name
    if path.exists() and not force:
        raise FileExistsError(f'{path} exists; pass --force to replace it')
    return path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--slow-pulse-source', required=True, type=Path)
    parser.add_argument('--deep-focus-source', required=True, type=Path)
    parser.add_argument('--lofi-hip-hop-source', required=True, type=Path)
    parser.add_argument('--quiet-piano-source', required=True, type=Path)
    parser.add_argument('--still-air-source', required=True, type=Path)
    parser.add_argument('--output-directory', required=True, type=Path)
    parser.add_argument('--force', action='store_true')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    jobs = [
        ('Slow Pulse', 'slow-pulse.wav', prepare_slow_pulse, args.slow_pulse_source),
        ('Deep Focus', 'deep-focus.wav', prepare_deep_focus, args.deep_focus_source),
        ('Lo-Fi Hip Hop', 'lofi-hip-hop.wav', prepare_lofi_hip_hop, args.lofi_hip_hop_source),
        ('Quiet Piano', 'quiet-piano.wav', prepare_quiet_piano, args.quiet_piano_source),
        ('Still Air', 'still-air.wav', prepare_still_air, args.still_air_source),
    ]
    outputs = {
        name: _output_path(args.output_directory, name, args.force)
        for _, name, _, _ in jobs
    }
    for label, name, prepare, source in jobs:
        path = outputs[name]
        audio = prepare(source)
        write_pcm16(path, audio, SAMPLE_RATE)
        _describe(label, path)


if __name__ == '__main__':
    main()
