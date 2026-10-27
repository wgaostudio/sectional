"""Rebuild the held-note sounds in static/soundfonts from the original MIDI.js soundfonts.

The FluidR3_GM samples converted to MIDI.js by Benjamin Gleitz
(https://github.com/gleitz/midi-js-soundfonts) are about 3 seconds long, so held notes went
silent early, and several have swells recorded into them. For the sustained instruments this
script, for each note from C2 to C6:

1. makes the sample 16 seconds long by looping its steady middle (the loop is a whole number
   of pitch periods and crossfaded, so the seam doesn't click), and
2. evens out its loudness after the attack, so any swell you hear comes from the music.

Needs ffmpeg and numpy.   python tools/make_long_sounds.py <midi-js-soundfonts/FluidR3_GM> static/soundfonts
"""
import os
import subprocess
import sys

import numpy as np

SR = 44100
NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
INSTRUMENTS = ["choir_aahs", "voice_oohs", "church_organ", "clarinet"]


def decode(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def encode(y, path):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-b:a", "64k", path], input=y.astype(np.float32).tobytes(), check=True)


def extend(x, midi, total=16.0):
    f0 = 440 * 2 ** ((midi - 69) / 12)
    a, X = int(1.0 * SR), int(0.15 * SR)
    L = int(round(round(1.5 * f0) * SR / f0))
    if a + L + X > len(x):
        raise ValueError("sample too short")
    t = np.linspace(0, np.pi / 2, X)
    fade_out, fade_in = np.cos(t), np.sin(t)
    chunks = [x[:a + L + X]]
    tail, n = chunks[0][-X:].copy(), len(chunks[0])
    while n < total * SR:
        chunks[-1] = chunks[-1][:-X]
        body = x[a + X:a + L + X]
        chunks += [x[a:a + X] * fade_in + tail * fade_out, body]
        tail = body[-X:].copy()
        n += L
    return np.concatenate(chunks)[: int(total * SR)]


def even_out(x):
    w = int(0.08 * SR)
    env = np.sqrt(np.maximum(np.convolve(x * x, np.ones(w) / w, mode="same"), 1e-12))
    target = np.median(env[int(0.4 * SR): int(2.5 * SR)])
    g = np.convolve(np.clip(target / env, 0.4, 3.0), np.ones(w) / w, mode="same")
    ramp = np.clip((np.arange(len(x)) - 0.06 * SR) / (0.04 * SR), 0, 1)   # keep the attack
    y = x * (1 + (g - 1) * ramp)
    y[-int(0.05 * SR):] *= np.linspace(1, 0, int(0.05 * SR))
    peak = np.max(np.abs(y))
    return y * (0.98 / peak) if peak > 0.98 else y


def main(src, dst):
    for inst in INSTRUMENTS:
        os.makedirs(f"{dst}/{inst}-mp3", exist_ok=True)
        for midi in range(36, 85):
            name = f"{NAMES[midi % 12]}{midi // 12 - 1}"
            x = decode(f"{src}/{inst}-mp3/{name}.mp3")
            encode(even_out(extend(x, midi)), f"{dst}/{inst}-mp3/{name}.mp3")
        print(inst, "done")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
