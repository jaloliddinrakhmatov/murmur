/**
 * A tiny shared signal between the hero demo and the WebGL voice field: 0 while the demo is idle,
 * 1 while it is "Listening". The field smooths it, so setting it is cheap and needs no React state.
 */
let energy = 0;

export const voiceSignal = {
  set(value: number) {
    energy = value;
  },
  get() {
    return energy;
  },
};
