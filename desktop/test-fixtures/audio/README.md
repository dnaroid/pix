# Generated Ogg decoder fixtures

These are original 0.1-second 440 Hz sine tones, not copied user audio.

```sh
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=0.1' -c:a libvorbis tone-vorbis.ogg
ffmpeg -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=0.1' -ac 2 -c:a libopus tone-opus.opus
```

Tests use the checked-in files and do not require FFmpeg.
