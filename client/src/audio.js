const sources = {
  rocket: '/assets/audio/rocket.ogg',
  blast: '/assets/audio/blast.ogg',
  background: '/assets/audio/background.ogg',
};

let backgroundAudio;

function readStoredSound() {
  try {
    return localStorage.getItem('airplain-sound') !== 'off';
  } catch {
    return true;
  }
}

let soundEnabled = readStoredSound();

export function isSoundEnabled() {
  return soundEnabled;
}

export function setSoundEnabled(enabled) {
  soundEnabled = enabled;
  if (!backgroundAudio) return;
  if (enabled) {
    const playback = backgroundAudio.play();
    if (playback) playback.catch(() => {});
  } else {
    backgroundAudio.pause();
  }
}

export function startBackground() {
  if (!backgroundAudio) {
    backgroundAudio = new Audio(sources.background);
    backgroundAudio.loop = true;
    backgroundAudio.volume = 0.32;
  }
  if (!soundEnabled) {
    backgroundAudio.pause();
    return;
  }
  const playback = backgroundAudio.play();
  if (playback) playback.catch(() => {});
}

export function playEffect(name, volume = 0.6) {
  if (!soundEnabled || !sources[name]) return;
  const effect = new Audio(sources[name]);
  effect.volume = volume;
  const playback = effect.play();
  if (playback) playback.catch(() => {});
  if (name === 'rocket') window.setTimeout(() => effect.pause(), 1100);
}
