# Bundled Soundscape Licenses

All seven soundscapes are stored and played locally. The source works are
released under Creative Commons CC0 1.0 Universal, which permits copying,
redistribution, commercial use, and modification without required attribution.
Credits are retained here and in `THIRD_PARTY_NOTICES.md` as a courtesy and for
source traceability.

License: https://creativecommons.org/publicdomain/zero/1.0/

Unless a section says otherwise, the canonical asset was prepared on
2026-07-31 with:

```text
ffmpeg -i <approved-source> -af loudnorm=I=-23:LRA=7:TP=-2 \
  -ar 44100 -c:a pcm_s16le public/audio/soundscapes/<id>.wav
```

## Deep Focus

- Canonical asset: `public/audio/soundscapes/deep-focus.wav`
- Original title: Contemplation
- Creator: Joth
- Source: https://opengameart.org/content/contemplation-0
- Downloaded: 2026-07-31
- License: CC0 1.0 Universal
- Attribution required: No
- Source SHA-256: `283962d3a975c93613c46cda30c9f0816176ae3e2899f961591a49e2d41b4bf3`
- Canonical SHA-256: `e4d06149ad0f8e0a99b2ff3a71be34be20e2b7f22031f76f185dace916467c0c`
- Preparation: Conversion from MP3 to stereo, 16-bit, 44.1 kHz PCM WAV,
  followed by an eight-second equal-power wrapped overlap and static loudness
  normalization. The resulting 112.058776-second file is a pure loop.

## Lo-Fi Hip Hop

- Canonical asset: `public/audio/soundscapes/lofi-hip-hop.wav`
- Original title: Lofi again
- Creator: omfgdude
- Source: https://opengameart.org/content/lofi-again
- Downloaded: 2026-07-31
- License: CC0 1.0 Universal
- Attribution required: No
- Provenance: The creator describes four instrumental tracks and ambience
  recorded with a Korg Triton; no third-party samples or prerecorded loops are
  disclosed.
- Source SHA-256: `d3b3410a186d45dadbcf87a8072b5a7f3b3f5a11fe38d9a7e9bdb3f66d5d86fa`
- Canonical SHA-256: `5f3bf225be664423f1082fd98a32f212af746e16471dd02e217c9580ca89a588`
- Preparation: A 72-second, 24-bar region beginning 6.8 seconds into the source
  was closed with a three-second equal-power overlap on its matching 80 BPM
  phase, then statically normalized and converted from mono Ogg Vorbis to mono,
  16-bit, 44.1 kHz PCM WAV.

## Quiet Piano

- Canonical asset: `public/audio/soundscapes/quiet-piano.wav`
- Original title: First Light Particles
- Creator: Yoiyami
- Source: https://opengameart.org/content/first-light-particles-%E2%80%93-cc0-atmospheric-pianoambient-track
- Downloaded: 2026-07-31
- License: CC0 1.0 Universal
- Attribution required: No
- Provenance: The creator states the work was composed from scratch without
  commercial sound sources, samples, loops, or third-party audio.
- Source SHA-256: `f0538a1a67450cc1d5e305fad5bc0d5d422ad809f720d695ab356e55fbe40fc5`
- Canonical SHA-256: `579f5d931eeec39f1d2af066aa0b5826d9066192b3c183a9b2e7becb7c1084ae`
- Preparation: Resampling from 48 kHz followed by an eight-second equal-power
  wrapped overlap that removes the source outro fade, static loudness
  normalization, and stereo, 16-bit, 44.1 kHz PCM encoding. The resulting
  pure loop is 123.72 seconds.

## Organic Drift

- Canonical asset: `public/audio/soundscapes/organic-drift.wav`
- Original title: A Small Fire Will Do (Calming Loop)
- Creator: Cal McEachern (Trex0n)
- Source: https://opengameart.org/content/a-small-fire-will-do-calming-loop
- Downloaded: 2026-07-31
- License: CC0 1.0 Universal
- Attribution required: No
- Source SHA-256: `1cb42057e724224d6047f651b95598f5c094caaaba47f6430dd5d540c09c4414`
- Canonical SHA-256: `2d468cf60ce62c8d7d86c6a87e0e5d18212c4f3a6c342df56092d2caed3abbaa`
- Preparation: Loudness normalization and conversion from 24-bit to 16-bit,
  44.1 kHz stereo PCM WAV.

## Still Air

- Canonical asset: `public/audio/soundscapes/still-air.wav`
- Original title: Cathedral in the Forest (ambient loop)
- Creator: congusbongus
- Source: https://opengameart.org/content/cathedral-in-the-forest-ambient-loop
- Downloaded: 2026-07-31
- License: CC0 1.0 Universal
- Attribution required: No
- Source SHA-256: `b9e05a1fcd5869b63193515e2a9c1bd578906a78e628e307f19527d387262593`
- Canonical SHA-256: `e4cbdbac59445fc01ebf3bf615b22d4b34cd7a816d08dd7d73b3a432fb0a923e`
- Preparation: A one-second equal-power wrapped overlap removes the compressed
  source boundary discontinuity while preserving the authored ambient loop,
  followed by static loudness normalization and conversion from Ogg Vorbis to
  stereo, 16-bit, 44.1 kHz PCM WAV.

## Rain Room

- Canonical asset: `public/audio/soundscapes/rain-room.wav`
- Source 1: Rain 7 by constantinov
- Source URL: https://freesound.org/people/constantinov/sounds/807703/
- Source 2: First Light Particles by Yoiyami
- Source URL: https://opengameart.org/content/first-light-particles-%E2%80%93-cc0-atmospheric-pianoambient-track
- Downloaded: 2026-07-31
- License: CC0 1.0 Universal for both sources
- Attribution required: No
- Rain source SHA-256: `fc2cf2e2026e1a109d27055ef4334e056781b6088c6db2b4b16ad2ea9806dbc5`
- Piano source SHA-256: `f0538a1a67450cc1d5e305fad5bc0d5d422ad809f720d695ab356e55fbe40fc5`
- Canonical SHA-256: `dfb510ddd429d46c69940b723e00bab8035f2a29a8d9061053ed6d79da6c1fe8`
- Preparation: Rain was softened with high-frequency reduction. Selected
  piano passages were filtered, slowed, and mixed quietly behind the weather.
  Six seconds of wrapped overlap created the approved 90-second loop, followed
  by a one-semitone downward pitch treatment that preserves duration, final
  loudness normalization, and 16-bit, 44.1 kHz PCM encoding.

## Slow Pulse

- Canonical asset: `public/audio/soundscapes/slow-pulse.wav`
- Original title: Safe Space
- Creator: Tsorthan Grove
- Source: https://opengameart.org/content/safe-space-0
- Downloaded: 2026-07-31
- License: CC0 1.0 Universal
- Attribution required: No
- Source SHA-256: `159a2bb84cfdbdbd6a519699d7a76bb1d4305a1afcaccf941fbea5d09b063e66`
- Canonical SHA-256: `136c76d90c4e5424ea9966ee48672aad2b2ccd093c867306129e64d5e701c767`
- Preparation: The complete authored loop was time-fitted without changing
  pitch and closed with an approximately two-second equal-power overlap. An
  original 88-bar rhythm at 148 BPM adds a 74 BPM perceived half-time pulse
  with synthesized kick, backbeat, shuffled hats, and restrained G-centered
  sub-bass. The combined 142.702698-second pure loop was statically normalized
  and encoded as stereo, 16-bit, 44.1 kHz PCM.
