from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from prepare_soundscape_loops import (
    equal_power_wrapped_loop,
    library_loop_frame_counts,
    pcm_format,
    seam_excerpt,
    slow_pulse_frame_count,
    synthesize_slow_pulse,
    write_pcm16,
)


class PrepareSoundscapeLoopsTest(unittest.TestCase):
    def test_slow_pulse_frame_count_matches_eighty_eight_bars(self) -> None:
        self.assertEqual(slow_pulse_frame_count(44_100), 6_293_189)

    def test_library_frame_counts_match_approved_loop_boundaries(self) -> None:
        self.assertEqual(
            library_loop_frame_counts(44_100),
            {
                'deep-focus': 4_941_792,
                'lofi-hip-hop': 3_175_200,
                'quiet-piano': 5_456_052,
                'organic-drift': 2_822_400,
                'still-air': 5_996_468,
                'rain-room': 3_969_000,
                'slow-pulse': 6_293_189,
            },
        )

    def test_wrapped_loop_preserves_length_and_source_order_at_boundary(self) -> None:
        source = np.arange(24, dtype=np.float32).reshape(12, 2) / 24.0

        looped = equal_power_wrapped_loop(source, 3)

        self.assertEqual(len(looped), 9)
        np.testing.assert_array_equal(looped[3:], source[3:9])
        np.testing.assert_array_equal(looped[0], source[9])

    def test_synthesis_is_deterministic_and_non_silent(self) -> None:
        first = synthesize_slow_pulse(8_000, 44_100)
        second = synthesize_slow_pulse(8_000, 44_100)

        np.testing.assert_array_equal(first, second)
        self.assertGreater(float(np.max(np.abs(first))), 0.0)

    def test_pcm_writer_emits_stereo_sixteen_bit_audio(self) -> None:
        audio = np.array([[0.0, 0.25], [-0.25, 0.0]], dtype=np.float32)

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'fixture.wav'
            write_pcm16(output, audio, 44_100)

            self.assertEqual(
                pcm_format(output),
                {
                    'sample_rate': 44_100,
                    'bits_per_sample': 16,
                    'channels': 2,
                    'frames': 2,
                },
            )

    def test_seam_excerpt_places_boundary_at_requested_offset(self) -> None:
        audio = np.arange(40, dtype=np.float32).reshape(20, 2)

        excerpt = seam_excerpt(audio, 2, before=2.0, after=3.0)

        np.testing.assert_array_equal(excerpt[:4], audio[-4:])
        np.testing.assert_array_equal(excerpt[4:], audio[:6])


if __name__ == '__main__':
    unittest.main()
