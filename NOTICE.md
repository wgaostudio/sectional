# Third-party notices

Sectional itself is MIT licensed (see [LICENSE](LICENSE)). It includes or uses:

## Included

- **Legato model code** (`vendor/legato/`): Copyright (c) 2025 Guang Yang, MIT License; the
  license and its own notices are in `vendor/legato/LICENSE.md`.
- **abcjs** (`static/vendor/abcjs-basic-min.js`): Copyright (c) Paul Rosen and Gregory Dyke,
  MIT License. https://github.com/paulrosen/abcjs
- **Sounds** (`static/soundfonts/`): the FluidR3_GM SoundFont by Frank Wen, as converted to
  MIDI.js by Benjamin Gleitz (https://github.com/gleitz/midi-js-soundfonts), licensed under
  [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/).
  **Changed:** for the clarinet, church organ, choir "aah" and voice "ooh" sounds, notes C2–C6
  were lengthened to 16 seconds by looping and their loudness evened out after the attack
  (`tools/make_long_sounds.py`). The piano and woodblock sounds are unchanged.
- **Sample score** (`samples/turtle-dove/`): *The Turtle Dove*, English folk song arranged by
  R. Vaughan Williams for men's voices and piano, published by J. Curwen & Sons in 1919 and in the
  public domain in the United States. The page images are scans of that edition; the reading
  was made with Legato 2 by this app.

## Downloaded at setup, not included

- **Legato 2 model weights**: https://huggingface.co/guangyangmusic/legato-2, Apache-2.0,
  gated; each user accepts its terms on Hugging Face.
- **Python packages** listed in `requirements.txt`, each under its own license. Note that
  `ultralytics` (used to find the lines of music on a page) is licensed under AGPL-3.0; if you
  distribute a modified version or offer it as a network service, check its terms.
