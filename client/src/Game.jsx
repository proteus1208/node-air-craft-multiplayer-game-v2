import { useEffect, useRef, useState } from 'react';
import SoundButton from './SoundButton.jsx';
import { playEffect } from './audio.js';
import { advancePrediction, latestInput, recordInput, sampleRemote } from './net.js';

const inputResendMs = 50;
const debugRefreshMs = 250;
const hiddenUntilPlaced = { left: 0, top: 0, visibility: 'hidden' };
const sameFlightInput = (left, right) => left.yaw === right.yaw && left.throttle === right.throttle;

const gearIcon = <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.95l-.36-2.54A.49.49 0 0 0 13.88 2h-3.76a.49.49 0 0 0-.49.42L9.27 4.96c-.6.24-1.14.56-1.63.95l-2.39-.96a.5.5 0 0 0-.61.22L2.72 8.49a.5.5 0 0 0 .12.64l2.03 1.58a6.5 6.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.12.21.37.3.61.22l2.39-.96c.49.39 1.03.71 1.63.95l.36 2.54c.03.24.24.42.49.42h3.76c.25 0 .46-.18.49-.42l.36-2.54c.6-.24 1.14-.56 1.63-.95l2.39.96c.24.09.49 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.02-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>;

const planeFiles = ['p1.png', 'p4-png.png', 'p3.png', 'p4.png', 'p5.png'];
const rocketColors = [1, 3, 2, 4, 5];
const mineColors = [3, 1, 2, 4, 5];
function blastStyle(blast) {
  const size = (blast.radius ?? 90) * 2 * 0.7;
  return {
    left: blast.x,
    top: blast.y,
    width: size,
    height: size,
  };
}

function spriteImageStyle(object, cameraScale = 1) {
  const imageName = ({ rock: 'rock', pool: 'lake', flower: 'f', cloud: 'c' })[object.type];
  const size = object.size / Math.max(cameraScale, 0.01);
  return {
    left: object.x,
    top: object.y,
    width: size,
    height: size,
    backgroundImage: 'url(/assets/things/' + imageName + '-' + object.variant + '.png)',
    backgroundRepeat: 'no-repeat',
    backgroundSize: '100% 100%',
    backgroundPosition: 'center',
  };
}

function aircraftStyle(player, cameraScale = 1) {
  const planeTier = planeTierForLevel(player);
  const sizeScale = (player.isBot ? 0.7 : 1) / Math.max(cameraScale, 0.01);
  const planeFile = planeFiles[planeTier - 1];
  return {
    width: 68 * sizeScale,
    height: 84 * sizeScale,
    backgroundImage: 'url(/assets/plain/' + planeFile + ')',
    backgroundSize: '100% 100%',
    backgroundPosition: 'center',
    '--aircraft-image': 'url(/assets/plain/' + planeFile + ')',
  };
}
function planeTierForLevel(player) {
  const level = player?.level ?? 1;
  return player?.planeTier ?? Math.ceil(Math.max(1, Math.min(15, level)) / 3);
}

function targetLockSize(player, cameraScale = 1) {
  const body = 84 * (player?.isBot ? 0.7 : 1);
  return body / Math.max(cameraScale, 0.01);
}

function enemyMarkerSize(weapon, cameraScale = 1) {
  const botScale = weapon.ownerIsBot ? 0.8 : 1;
  const longestSide = weapon.type === 'mine' ? 32 : (weapon.mineLaunched ? 24 : 34);
  return (longestSide * botScale) / Math.max(cameraScale, 0.01);
}

function weaponImageStyle(weapon, cameraScale = 1) {
  const color = (weapon.type === 'rocket' ? rocketColors : mineColors)[Math.min(5, weapon.variant ?? 1) - 1];
  const prefix = weapon.type === 'rocket' ? 'r' : 'm';
  const botScale = weapon.ownerIsBot ? 0.8 : 1;
  const baseWidth = weapon.type === 'mine' ? 32 : (weapon.mineLaunched ? 21 : 30);
  const baseHeight = weapon.type === 'mine' ? 32 : (weapon.mineLaunched ? 24 : 34);
  return {
    backgroundImage: 'url(/assets/plain/' + prefix + color + '.png)',
    ...(weapon.ownerIsBot || weapon.mineLaunched || cameraScale !== 1
      ? { width: baseWidth * botScale / Math.max(cameraScale, 0.01), height: baseHeight * botScale / Math.max(cameraScale, 0.01) }
      : {}),
  };
}
function healthColor(hp, maxHp) {
  const ratio = maxHp > 0 ? hp / maxHp : 0;
  if (ratio <= 0.25) return '#ff5363';
  if (ratio <= 0.55) return '#ffd45e';
  return '#62f09c';
}

function detectTouchMode() {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const mobileAgent = navigator.userAgentData?.mobile === true;
  const touchPrimary = window.matchMedia?.('(pointer: coarse)').matches && window.matchMedia?.('(hover: none)').matches;
  return Boolean(mobileAgent || touchPrimary || navigator.maxTouchPoints > 0);
}

function teamRingSize(cameraScale = 1) {
  return 120 / Math.max(cameraScale, 0.01);
}

function teamLabel(player) {
  if (player.teamName) return player.teamName;
  if (player.teamId === 'team:a') return 'A';
  if (player.teamId === 'team:b') return 'B';
  if (player.teamId?.startsWith('team:')) return player.teamId.slice(5);
  return '-';
}

function compactKey(key) {
  if (key === ' ') return 'SPC';
  if (key.startsWith('Arrow')) return key.slice(5, 6).toUpperCase();
  return key.length > 3 ? key.slice(0, 3).toUpperCase() : key.toUpperCase();
}

function readDebugFlag() {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug');
}

export default function Game({ world, playerName, playerId, gameState, net, connectionStatus = 'connected', controls, teamCode, teamDamageEnabled, roomId = '', team = 'solo', teamPassword = '', sendMessage, onBack, onSettings, settingsOpen = false, soundOn = true, onToggleSound }) {
  const heldKeys = useRef(new Set());
  const weaponReadyRef = useRef({ rocket: true, mine: true });
  const touchAnalog = useRef({ yaw: 0, throttle: 0 });
  const viewportRef = useRef(null);
  const worldRef = useRef(null);
  const ownPlaneRef = useRef(null);
  const miniPlayerRef = useRef(null);
  const miniViewRef = useRef(null);
  const viewRef = useRef({ sceneryScale: 1, width: 0, height: 0, worldWidth: 1, worldHeight: 1, fallback: null });
  const inputStateRef = useRef(null);
  const entityEls = useRef({ players: new Map(), rockets: new Map() });
  const entityRefCallbacks = useRef(new Map());
  const inputPacketRef = useRef(null);
  const inputSentAtRef = useRef(0);
  const [debugOpen, setDebugOpen] = useState(readDebugFlag);
  const [debugStats, setDebugStats] = useState(null);
  const [banners, setBanners] = useState([]);
  const [hitCombo, setHitCombo] = useState({ count: 0, pulse: 0 });
  const hitResetAt = useRef(0);
  const hitCountRef = useRef(0);
  const [weaponPress, setWeaponPress] = useState({ type: '', serial: 0 });
  const [ammoRechargePulse, setAmmoRechargePulse] = useState({ rocket: 0, mine: 0 });
  const previousAmmo = useRef(null);
  const heardWeapons = useRef(null);
  const lastEffectAt = useRef({ rocket: 0, blast: 0 });
  const [touchMode] = useState(detectTouchMode);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [mobileStick, setMobileStick] = useState({ x: 0, y: 0 });
  const stateForDisplay = gameState;
  const players = stateForDisplay?.players ?? [];
  const trackedTargetIds = new Set((stateForDisplay?.rockets ?? []).filter((rocket) => rocket.active && rocket.trackingTargetId).map((rocket) => rocket.trackingTargetId));
  const isEnemyWeapon = (weapon) => weapon.ownerId !== playerId && (!ownPlayer.teamId || !weapon.ownerTeamId || weapon.ownerTeamId !== ownPlayer.teamId);
  const ownPlayer = players.find((player) => player.id === playerId) ?? {
    id: playerId,
    name: playerName || 'Pilot',
    x: (world?.width ?? 0) / 2,
    y: (world?.height ?? 0) / 2,
    angle: 0,
    speed: 150,
    speedKmh: 150,
    minSpeedKmh: 150,
    maxSpeedKmh: 206,
    hp: 100,
    maxHp: 100,
    level: 1,
    cameraScale: 1,
    isBot: false,
    outOfMap: false,
    attackedAt: 0,
    xp: 0,
    xpForNextLevel: 100,
    rocketAmmo: 3,
    rocketCapacity: 3,
    rocketPhase: 'ready',
    rocketPhaseRemaining: 0,
    rocketPrepareMs: 1000,
    rocketChargeMs: 2300,
    mineAmmo: 2,
    mineCapacity: 2,
    score: 0,
    kills: 0,
    teamId: null,
    minePhase: 'ready',
    minePhaseRemaining: 0,
    minePrepareMs: 2000,
    mineChargeMs: 5000,
  };
  const visiblePlayers = (players.length ? players : [ownPlayer]).filter((player) => player.hp > 0);
  const rankingPlayers = [...players].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || (b.kills ?? 0) - (a.kills ?? 0) || b.level - a.level).slice(0, 7);
  const inputState = () => {
    const input = Object.fromEntries(Object.keys(controls).map((name) => [name, heldKeys.current.has(name)]));
    const clamp = (value) => Math.max(-1, Math.min(1, value));
    const keyboardYaw = Number(input.right) - Number(input.left);
    const keyboardThrottle = Number(input['speed-up']) - Number(input['speed-down']);
    return { ...input, yaw: clamp(keyboardYaw + touchAnalog.current.yaw), throttle: clamp(keyboardThrottle + touchAnalog.current.throttle) };
  };
  inputStateRef.current = inputState;
  const sendInput = (input, force = false) => {
    const flightInput = { yaw: input.yaw, throttle: input.throttle };
    const now = performance.now();
    const previous = inputPacketRef.current;
    const changed = !previous || !sameFlightInput(previous.input, flightInput);
    // A direction change is sent immediately. Repeated state is sent at 20Hz
    // so lost packets recover without browser key-repeat or pointer-move spam.
    if (!changed && !force && now - inputSentAtRef.current < inputResendMs) return;
    if (changed) {
      const seq = net ? recordInput(net, flightInput, now) : undefined;
      inputPacketRef.current = { type: 'i', seq, i: [flightInput.yaw, flightInput.throttle], input: flightInput };
    }
    if (!inputPacketRef.current) return;
    inputSentAtRef.current = now;
    const { input: _input, ...packet } = inputPacketRef.current;
    sendMessage(packet);
  };
  const sendAction = (type) => {
    const seq = net ? recordInput(net, latestInput(net), performance.now()) : undefined;
    sendMessage({ type, seq });
  };
  // Moving entities are positioned by the frame loop, not by React, so each
  // one registers its DOM node here.
  const entityRef = (kind, id) => {
    const key = kind + ':' + id;
    let callback = entityRefCallbacks.current.get(key);
    if (!callback) {
      callback = (element) => {
        const registry = entityEls.current[kind];
        if (element) {
          registry.set(id, { root: element, plane: element.querySelector('.map-player') });
        } else {
          registry.delete(id);
          entityRefCallbacks.current.delete(key);
        }
      };
      entityRefCallbacks.current.set(key, callback);
    }
    return callback;
  };
  const updateMobileStick = (event) => {
    if (settingsOpen) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const zoom = Math.max(0.35, uiScale || 1);
    const maxTravel = Math.min(rect.width, rect.height) * 0.28 / zoom;
    const dx = (event.clientX - (rect.left + rect.width / 2)) / zoom;
    const dy = (event.clientY - (rect.top + rect.height / 2)) / zoom;
    let x = Math.max(-1, Math.min(1, dx / maxTravel));
    let y = Math.max(-1, Math.min(1, dy / maxTravel));
    const magnitude = Math.hypot(x, y);
    if (magnitude > 1) { x /= magnitude; y /= magnitude; }
    const applyDeadZone = (value) => Math.abs(value) < 0.04 ? 0 : Math.sign(value) * ((Math.abs(value) - 0.04) / 0.96);
    touchAnalog.current = { yaw: applyDeadZone(x), throttle: -applyDeadZone(y) };
    setMobileStick({ x: x * maxTravel, y: y * maxTravel });
    sendInput(inputState());
  };
  const releaseMobileStick = () => {
    touchAnalog.current = { yaw: 0, throttle: 0 };
    setMobileStick({ x: 0, y: 0 });
    sendInput(inputState());
  };

  useEffect(() => {
    if (!gameState) return;
    const rockets = (gameState.rockets ?? []).filter((rocket) => rocket.active && !rocket.mineLaunched);
    const blasts = gameState.blasts ?? [];
    const heard = heardWeapons.current;
    if (!heard) {
      heardWeapons.current = {
        rockets: new Set(rockets.map((rocket) => rocket.id)),
        blasts: new Set(blasts.map((blast) => blast.id)),
      };
      return;
    }
    const now = performance.now();
    for (const rocket of rockets) {
      if (heard.rockets.has(rocket.id)) continue;
      heard.rockets.add(rocket.id);
      const ownRocket = rocket.ownerId === playerId;
      if (!ownRocket && now - lastEffectAt.current.rocket < 320) continue;
      lastEffectAt.current.rocket = now;
      playEffect('rocket', ownRocket ? 0.62 : 0.32);
    }
    for (const blast of blasts) {
      if (heard.blasts.has(blast.id)) continue;
      heard.blasts.add(blast.id);
      if (now - lastEffectAt.current.blast < 220) continue;
      lastEffectAt.current.blast = now;
      playEffect('blast', 0.74);
    }
    const rocketIds = new Set(rockets.map((rocket) => rocket.id));
    const blastIds = new Set(blasts.map((blast) => blast.id));
    for (const id of heard.rockets) if (!rocketIds.has(id)) heard.rockets.delete(id);
    for (const id of heard.blasts) if (!blastIds.has(id)) heard.blasts.delete(id);
  }, [gameState, playerId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const measure = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previous = previousAmmo.current;
    if (previous && previous.spawnedAt === ownPlayer.spawnedAt) {
      const rocketRecharged = ownPlayer.rocketAmmo > previous.rocket;
      const mineRecharged = ownPlayer.mineAmmo > previous.mine;
      if (rocketRecharged || mineRecharged) {
        setAmmoRechargePulse((pulse) => ({
          rocket: pulse.rocket + (rocketRecharged ? 1 : 0),
          mine: pulse.mine + (mineRecharged ? 1 : 0),
        }));
      }
    }
    previousAmmo.current = {
      spawnedAt: ownPlayer.spawnedAt,
      rocket: ownPlayer.rocketAmmo,
      mine: ownPlayer.mineAmmo,
    };
  }, [ownPlayer.spawnedAt, ownPlayer.rocketAmmo, ownPlayer.mineAmmo]);

  // Positions change every frame, so they are written straight to the DOM here
  // instead of going through React state.
  useEffect(() => {
    let frameId;
    let frames = 0;
    let fpsStartedAt = performance.now();
    const drawFrame = () => {
      frameId = window.requestAnimationFrame(drawFrame);
      const now = performance.now();
      frames += 1;
      if (net && now - fpsStartedAt >= 1000) {
        net.stats.fps = Math.round((frames * 1000) / (now - fpsStartedAt));
        frames = 0;
        fpsStartedAt = now;
      }
      const view = viewRef.current;
      const own = (net && inputStateRef.current ? advancePrediction(net, inputStateRef.current(), now) : null) ?? view.fallback;
      if (own) {
        const scale = view.sceneryScale;
        const viewport = viewportRef.current;
        if (viewport) viewport.style.backgroundPosition = 'calc(50% - ' + (own.x * scale) + 'px) calc(50% - ' + (own.y * scale) + 'px)';
        if (worldRef.current) worldRef.current.style.transform = 'translate3d(' + (view.width / 2 - own.x * scale) + 'px, ' + (view.height / 2 - own.y * scale) + 'px, 0) scale(' + scale + ')';
        if (ownPlaneRef.current) ownPlaneRef.current.style.transform = 'rotate(' + own.angle + 'deg)';
        const left = (own.x / view.worldWidth) * 100 + '%';
        const top = (own.y / view.worldHeight) * 100 + '%';
        if (miniPlayerRef.current) { miniPlayerRef.current.style.left = left; miniPlayerRef.current.style.top = top; }
        if (miniViewRef.current) { miniViewRef.current.style.left = left; miniViewRef.current.style.top = top; }
      }
      const sample = net ? sampleRemote(net, now) : null;
      if (net?.fx?.length) {
        const events = net.fx.splice(0, net.fx.length);
        const stamp = Date.now();
        let pulsed = false;
        const notices = [];
        for (const event of events) {
          if (event[0] === 'h') {
            hitCountRef.current = stamp > hitResetAt.current ? 1 : hitCountRef.current + 1;
            hitResetAt.current = stamp + 3000;
            pulsed = true;
          } else if (event[0] === 'k') {
            notices.push({ id: `${stamp}-k-${notices.length}`, kind: 'kill', text: `You just killed ${event[1]}` });
          } else if (event[0] === 'l') {
            notices.push({ id: `${stamp}-l-${notices.length}`, kind: 'level', text: `Level up · ${event[1]}` });
          }
        }
        if (pulsed) setHitCombo((current) => ({ count: hitCountRef.current, pulse: current.pulse + 1 }));
        if (notices.length) {
          setBanners((current) => [...current, ...notices].slice(-5));
          window.setTimeout(() => {
            const ids = new Set(notices.map((notice) => notice.id));
            setBanners((current) => current.filter((notice) => !ids.has(notice.id)));
          }, 2200);
        }
      }
      if (!sample) return;
      for (const [id, element] of entityEls.current.players) {
        const position = sample.players.get(id);
        if (!position) continue;
        element.root.style.transform = 'translate3d(' + position.x + 'px, ' + position.y + 'px, 0) translate(-50%, -50%)';
        element.root.style.visibility = 'visible';
        if (element.plane) element.plane.style.transform = 'rotate(' + position.angle + 'deg)';
      }
      for (const [id, element] of entityEls.current.rockets) {
        const position = sample.rockets.get(id);
        if (!position) continue;
        element.root.style.transform = 'translate3d(' + position.x + 'px, ' + position.y + 'px, 0) translate(-50%, -50%) rotate(' + position.angle + 'deg)';
        element.root.style.visibility = 'visible';
      }
    };
    frameId = window.requestAnimationFrame(drawFrame);
    return () => window.cancelAnimationFrame(frameId);
  }, [net]);

  useEffect(() => {
    if (!hitCombo.count) return undefined;
    const timer = window.setTimeout(() => {
      if (Date.now() >= hitResetAt.current) {
        hitCountRef.current = 0;
        setHitCombo((current) => ({ ...current, count: 0 }));
      }
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [hitCombo.pulse, hitCombo.count]);

  useEffect(() => {
    if (!debugOpen || !net) return undefined;
    const refresh = () => setDebugStats({ ...net.stats });
    refresh();
    const interval = window.setInterval(refresh, debugRefreshMs);
    return () => window.clearInterval(interval);
  }, [debugOpen, net]);

  useEffect(() => {
    if (net) {
      net.predicted = null;
      net.me = null;
      net.history = [];
      net.meta = new Map();
      net.fx = [];
    }
    sendMessage({ type: 'join', id: playerId, name: playerName, teamCode, teamDamageEnabled, roomId, team, teamPassword });
    return () => {
      heldKeys.current.clear();
      sendInput({});
    };
  }, [playerId, playerName, teamCode, teamDamageEnabled, roomId, team, teamPassword, sendMessage]);

  useEffect(() => {
    const keyToControl = new Map(Object.entries(controls).map(([name, key]) => [key.toLowerCase(), name]));
    keyToControl.set('arrowleft', 'left');
    keyToControl.set('arrowright', 'right');
    const updateInput = () => sendInput(inputState());
    const onKeyDown = (event) => {
      if (event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
      if (event.code === 'Backquote' && !event.repeat) {
        setDebugOpen((open) => !open);
        return;
      }
      if (settingsOpen) return;
      const key = event.key.toLowerCase();
      const control = keyToControl.get(key);
      if (!control) return;
      event.preventDefault();
      if (control === 'rocket' || control === 'mine') {
        if (event.repeat || !weaponReadyRef.current[control]) return;
        setWeaponPress((current) => ({ type: control, serial: current.serial + 1 }));
        sendAction(control === 'rocket' ? 'launch-rocket' : 'drop-mine');
        return;
      }
      if (control === 'fast') {
        if (!event.repeat) sendAction('activate-fast');
        return;
      }
      if (event.repeat || heldKeys.current.has(control)) return;
      heldKeys.current.add(control);
      updateInput();
    };
    const onKeyUp = (event) => {
      if (settingsOpen) return;
      const control = keyToControl.get(event.key.toLowerCase());
      if (!control || control === 'rocket' || control === 'mine' || control === 'fast') return;
      if (!heldKeys.current.has(control)) return;
      heldKeys.current.delete(control);
      updateInput();
    };
    const onBlur = () => {
      heldKeys.current.clear();
      touchAnalog.current = { yaw: 0, throttle: 0 };
      setMobileStick({ x: 0, y: 0 });
      updateInput();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    // While a control is held the input is repeated, so one lost or late
    // packet cannot leave the plane turning on stale input.
    const interval = window.setInterval(() => {
      const touch = touchAnalog.current;
      if (heldKeys.current.size || touch.yaw || touch.throttle) updateInput();
    }, inputResendMs);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [controls, sendMessage, settingsOpen]);

  useEffect(() => {
    if (settingsOpen) {
      heldKeys.current.clear();
      touchAnalog.current = { yaw: 0, throttle: 0 };
      setMobileStick({ x: 0, y: 0 });
      sendInput({});
    }
  }, [settingsOpen, sendMessage]);

  const speedKmh = Math.round(ownPlayer.speedKmh ?? ownPlayer.speed ?? 0);
  const minSpeedKmh = ownPlayer.minSpeedKmh ?? speedKmh;
  const maxSpeedKmh = ownPlayer.maxSpeedKmh ?? speedKmh;
  const speedProgress = maxSpeedKmh === minSpeedKmh ? 0 : ((speedKmh - minSpeedKmh) / (maxSpeedKmh - minSpeedKmh)) * 100;
  const fastActiveRemainingMs = ownPlayer.fastActiveRemainingMs ?? 0;
  const fastCooldownRemainingMs = ownPlayer.fastCooldownRemainingMs ?? 0;
  const fastCooldownMs = ownPlayer.fastCooldownMs ?? 10000;
  const fastDurationMs = ownPlayer.fastDurationMs ?? 3000;
  const fastDurationSeconds = (fastDurationMs / 1000).toFixed(0);
  const fastReadyProgress = Math.max(0, Math.min(1, 1 - fastCooldownRemainingMs / fastCooldownMs));
  const rocketReady = (ownPlayer.rocketAmmo ?? 0) > 0 && ownPlayer.rocketPhase !== 'preparing' && !(ownPlayer.spawnProtectionRemainingMs > 0);
  const mineReady = (ownPlayer.mineAmmo ?? 0) > 0 && ownPlayer.minePhase !== 'preparing' && !(ownPlayer.spawnProtectionRemainingMs > 0);
  weaponReadyRef.current.rocket = rocketReady;
  weaponReadyRef.current.mine = mineReady;
  const rocketMeter = ownPlayer.rocketPhase === 'preparing' && ownPlayer.rocketPrepareMs
    ? Math.max(0, Math.min(1, 1 - (ownPlayer.rocketPhaseRemaining ?? 0) / ownPlayer.rocketPrepareMs))
    : (ownPlayer.rocketAmmo >= ownPlayer.rocketCapacity ? 1 : (ownPlayer.rocketChargeProgress ?? 0));
  const mineMeter = ownPlayer.minePhase === 'preparing' && ownPlayer.minePrepareMs
    ? Math.max(0, Math.min(1, 1 - (ownPlayer.minePhaseRemaining ?? 0) / ownPlayer.minePrepareMs))
    : (ownPlayer.mineAmmo >= ownPlayer.mineCapacity ? 1 : (ownPlayer.mineChargeProgress ?? 0));
  const targetCameraScale = ownPlayer.cameraScale ?? 1;
  const [cameraScale, setCameraScale] = useState(targetCameraScale);
  const cameraScaleRef = useRef(targetCameraScale);
  useEffect(() => {
    const startScale = cameraScaleRef.current;
    if (Math.abs(startScale - targetCameraScale) < 0.001) return undefined;
    let startedAt = null;
    let frameId;
    const animateZoom = (timestamp) => {
      startedAt ??= timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / 700);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - ((-2 * progress + 2) ** 2) / 2;
      const nextScale = startScale + (targetCameraScale - startScale) * eased;
      cameraScaleRef.current = nextScale;
      setCameraScale(nextScale);
      if (progress < 1) frameId = window.requestAnimationFrame(animateZoom);
      else cameraScaleRef.current = targetCameraScale;
    };
    frameId = window.requestAnimationFrame(animateZoom);
    return () => window.cancelAnimationFrame(frameId);
  }, [targetCameraScale]);
  const scaleBaseArea = touchMode ? 390 * 844 : 1280 * 720;
  const uiScale = viewportSize.width && viewportSize.height ? Math.max(0.35, Math.min(3, Math.sqrt((viewportSize.width * viewportSize.height) / scaleBaseArea))) : 1;
  const sceneryScale = cameraScale * uiScale;
  const miniMapViewWidth = world ? Math.min(100, (viewportSize.width / sceneryScale / world.width) * 100) : 16;
  const miniMapViewHeight = world ? Math.min(100, (viewportSize.height / sceneryScale / world.height) * 100) : 16;
  viewRef.current = {
    sceneryScale,
    width: viewportSize.width,
    height: viewportSize.height,
    worldWidth: world?.width || 1,
    worldHeight: world?.height || 1,
    fallback: { x: ownPlayer.x, y: ownPlayer.y, angle: ownPlayer.angle },
  };
  const experienceProgress = ownPlayer.xpForNextLevel ? (ownPlayer.xp / ownPlayer.xpForNextLevel) * 100 : 100;
  const healthRatio = ownPlayer.maxHp > 0 ? ownPlayer.hp / ownPlayer.maxHp : 1;
  const attackFade = ownPlayer.attackedAt ? Math.max(0, 1 - (Date.now() - ownPlayer.attackedAt) / 1200) : 0;
  const lowHealthOpacity = healthRatio < 0.35 ? ((0.35 - healthRatio) / 0.35) * 0.3 : 0;
  const dangerOpacity = Math.min(0.36, Math.max(ownPlayer.outOfMap ? 0.27 : 0, attackFade * 0.36, lowHealthOpacity));

  return (
    <main className={`game-screen ${touchMode ? 'game-screen--mobile' : ''}`} aria-label="Air Plain game" style={{ '--viewport-ui-scale': uiScale }}>
      <div className="game-viewport" ref={viewportRef} style={{ backgroundImage: "url('/assets/ground pattern.png')", backgroundSize: (760 * sceneryScale) + 'px ' + (760 * sceneryScale) + 'px' }}>
        {world ? <div className="game-world" ref={worldRef} style={{ position: 'absolute', left: 0, top: 0, width: world.width, height: world.height, transformOrigin: '0 0' }}>
          {(world.objects ?? []).map((object) => object.type === 'tree'
            ? <img className="map-object map-tree-image" key={object.id} src={`/assets/trees/t${object.variant}.png`} alt="" aria-hidden="true" style={{ left: object.x, top: object.y, width: object.size / cameraScale, height: (object.size * 1.2) / cameraScale }} />
            : <div className="map-object map-sprite" key={object.id} style={spriteImageStyle(object, cameraScale)} aria-hidden="true" />)}
          {(world.clouds ?? []).map((cloud, index) => <div className="map-object map-cloud" key={cloud.id} style={{ ...spriteImageStyle(cloud, cameraScale), left: cloud.x, top: cloud.y, animationDuration: `${14 + cloud.variant * 1.6}s, ${20 + cloud.variant * 2}s`, animationDelay: `${-index * 1.7}s, ${-index * 3.4}s` }} aria-hidden="true" />)}
          {visiblePlayers.filter((player) => player.id !== playerId).map((player) => <div className={`aircraft-entity ${player.id === playerId ? 'aircraft-entity--self' : (player.isBot ? 'aircraft-entity--bot' : '')} ${player.spawnProtectionRemainingMs > 0 ? 'aircraft-entity--spawn-protected' : ''} ${trackedTargetIds.has(player.id) ? 'aircraft-entity--tracked' : ''}`} key={player.id} ref={entityRef('players', player.id)} style={hiddenUntilPlaced}>
            {ownPlayer.teamId && player.teamId === ownPlayer.teamId && <i className="aircraft-team-ring" style={{ width: teamRingSize(cameraScale), height: teamRingSize(cameraScale) }} aria-hidden="true" />}
            <div className="aircraft-tag" style={{ zoom: 1 / cameraScale }}>
              <strong><span className="aircraft-tag__level">LV {player.level}</span><span>{player.name}</span></strong>
              <span className="aircraft-tag__hp"><i style={{ width: `${Math.max(0, (player.hp / player.maxHp) * 100)}%`, backgroundColor: healthColor(player.hp, player.maxHp) }} /></span>
            </div>
            <div className="map-player" style={aircraftStyle(player, cameraScale)} role="img" aria-label={`Plane for ${player.name}`} />
            {trackedTargetIds.has(player.id) && <i className="aircraft-target-lock" style={{ width: `${targetLockSize(player, cameraScale)}px`, height: `${targetLockSize(player, cameraScale)}px` }} aria-hidden="true" />}
          </div>)}
          {(stateForDisplay?.rockets ?? []).filter((rocket) => rocket.active).map((rocket) => { const marker = enemyMarkerSize({ type: 'rocket', ownerIsBot: rocket.ownerIsBot, mineLaunched: rocket.mineLaunched }, cameraScale); return <i className={'world-rocket ' + (rocket.ownerIsBot ? 'world-rocket--bot ' : '') + (rocket.mineLaunched ? 'world-rocket--mine ' : '') + (isEnemyWeapon(rocket) ? 'world-rocket--enemy' : '')} key={rocket.id} ref={entityRef('rockets', rocket.id)} style={{ ...weaponImageStyle({ type: 'rocket', variant: rocket.variant, ownerIsBot: rocket.ownerIsBot, mineLaunched: rocket.mineLaunched }, cameraScale), ...hiddenUntilPlaced }}>{isEnemyWeapon(rocket) && <i className="world-weapon-enemy-marker" style={{ width: marker, height: marker }} aria-hidden="true" />}</i>; })}
          {(stateForDisplay?.mines ?? []).filter((mine) => mine.visible).map((mine) => { const marker = enemyMarkerSize({ type: 'mine', ownerIsBot: mine.ownerIsBot }, cameraScale); return <i className={'world-mine ' + (mine.armed ? 'world-mine--armed ' : '') + (isEnemyWeapon(mine) ? 'world-mine--enemy' : '')} key={mine.id} style={{ ...weaponImageStyle({ type: 'mine', variant: mine.variant, ownerIsBot: mine.ownerIsBot }, cameraScale), left: mine.x, top: mine.y }}>{isEnemyWeapon(mine) && <i className="world-weapon-enemy-marker" style={{ width: marker, height: marker }} aria-hidden="true" />}</i>; })}
          {(stateForDisplay?.blasts ?? []).map((blast) => <i className="map-object world-blast" key={blast.id} style={blastStyle(blast)} aria-hidden="true" />)}
        </div> : <div className="game-loading" role="status">Preparing your world…</div>}
        {world && ownPlayer.hp > 0 && <div className={'aircraft-entity aircraft-entity--self ' + (ownPlayer.spawnProtectionRemainingMs > 0 ? 'aircraft-entity--spawn-protected ' : '') + (trackedTargetIds.has(playerId) ? 'aircraft-entity--tracked' : '')} style={{ left: '50%', top: '50%', transform: 'translate3d(-50%, -50%, 0) scale(' + uiScale + ')' }}>
          {ownPlayer.teamId && <i className="aircraft-team-ring" style={{ width: teamRingSize(1), height: teamRingSize(1) }} aria-hidden="true" />}
          <div className="aircraft-tag">
            <strong><span className="aircraft-tag__level">LV {ownPlayer.level}</span><span>{ownPlayer.name}</span></strong>
            <span className="aircraft-tag__hp"><i style={{ width: String(Math.max(0, (ownPlayer.hp / ownPlayer.maxHp) * 100)) + '%', backgroundColor: healthColor(ownPlayer.hp, ownPlayer.maxHp) }} /></span>
          </div>
          <div className="map-player" ref={ownPlaneRef} style={aircraftStyle(ownPlayer)} role="img" aria-label={'Plane for ' + ownPlayer.name} />
          {trackedTargetIds.has(playerId) && <i className="aircraft-target-lock" style={{ width: `${targetLockSize(ownPlayer)}px`, height: `${targetLockSize(ownPlayer)}px` }} aria-hidden="true" />}
        </div>}
      </div>

      {touchMode && <div className="mobile-flight-controls" aria-label="Mobile flight controls">
        <span className="mobile-flight-controls__label">YAW <i>·</i> SPEED</span>
        <button className="mobile-flight-controls__stick" type="button" aria-label="Flight control: drag horizontally to steer and vertically to change speed" onPointerDown={(event) => { event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); updateMobileStick(event); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateMobileStick(event); }} onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); releaseMobileStick(); }} onPointerCancel={releaseMobileStick}>
          <i className="mobile-flight-controls__crosshair" aria-hidden="true" />
          <span className="mobile-flight-controls__direction mobile-flight-controls__direction--up" aria-hidden="true">+</span>
          <span className="mobile-flight-controls__direction mobile-flight-controls__direction--down" aria-hidden="true">−</span>
          <span className="mobile-flight-controls__direction mobile-flight-controls__direction--left" aria-hidden="true">‹</span>
          <span className="mobile-flight-controls__direction mobile-flight-controls__direction--right" aria-hidden="true">›</span>
          <i className="mobile-flight-controls__knob" aria-hidden="true" style={{ '--stick-x': `${mobileStick.x}px`, '--stick-y': `${mobileStick.y}px` }} />
        </button>
        <span className="mobile-flight-controls__hint">DRAG TO STEER / THROTTLE</span>
      </div>}

      <img className="danger-overlay" src="/assets/danger.png" alt="" aria-hidden="true" style={{ opacity: dangerOpacity }} />
      {hitCombo.count > 0 && <div className="hit-toast" key={hitCombo.pulse} aria-live="polite">HIT × {hitCombo.count}</div>}
      <div className="combat-banners" aria-live="polite">
        {banners.map((banner) => <strong className={`combat-banner combat-banner--${banner.kind}`} key={banner.id}>{banner.text}</strong>)}
      </div>
      {connectionStatus !== 'connected' && <div className="connection-banner" role="status" aria-live="polite">Reconnecting to flight control…</div>}
      {debugOpen && <aside className="net-debug" aria-label="Network statistics">
        <span>PING <b>{debugStats?.rtt ?? 0} ms</b></span>
        <span>SNAPSHOTS <b>{debugStats?.snapshotRate ?? 0}/s</b></span>
        <span>DOWN <b>{((debugStats?.byteRate ?? 0) / 1024).toFixed(1)} KB/s</b></span>
        <span>BUFFER <b>{debugStats?.bufferMs ?? 0} ms</b></span>
        <span>PRED ERR <b>{debugStats?.predictionError ?? 0} px</b></span>
        <span>FPS <b>{debugStats?.fps ?? 0}</b></span>
      </aside>}
      {ownPlayer.hp <= 0 && (ownPlayer.respawnRemainingMs ?? 0) > 0 && <div className="respawn-timer" role="timer" aria-live="polite"><span>RESPAWNING IN</span><strong>{Math.ceil(ownPlayer.respawnRemainingMs / 1000)}s</strong></div>}

      <header className="game-toolbar">
        <button className="game-toolbar__back menu__button--primary" type="button" onClick={onBack} aria-label="Back to menu" title="Back to menu"><span aria-hidden="true">←</span></button>
        <section className="flight-hud" aria-label="Aircraft status">
          <div className="flight-hud__plane-level"><span>PLANE</span><strong>LEVEL {ownPlayer.level}</strong></div>
          <div className="flight-hud__meter">
            <div className="flight-hud__meter-label"><span>HP</span><strong>{Math.round(ownPlayer.hp)} / {Math.round(ownPlayer.maxHp)}</strong></div>
            <div className="flight-hud__track"><span className="flight-hud__health" style={{ width: `${Math.max(0, (ownPlayer.hp / ownPlayer.maxHp) * 100)}%`, backgroundColor: healthColor(ownPlayer.hp, ownPlayer.maxHp) }} /></div>
          </div>
          <div className="flight-hud__meter flight-hud__meter--progress" aria-label="Level progress">
            <div className="flight-hud__meter-label"><span>NEXT LEVEL</span></div>
            <div className="flight-hud__track"><span className="flight-hud__progress" style={{ width: `${experienceProgress}%` }} /></div>
          </div>
        </section>
        <SoundButton className="game-toolbar__sound" soundOn={soundOn} onClick={onToggleSound} />
        <button className="top-actions__button game-toolbar__settings" type="button" onClick={onSettings} aria-label="Open settings" title="Settings">{gearIcon}</button>
      </header>

      <aside className="speed-board" aria-label={`Speed ${speedKmh} kilometers per hour, range ${minSpeedKmh} to ${maxSpeedKmh}`}>
        <div className="speed-board__top"><span>AIR SPEED</span><strong>{speedKmh}<small> km/h</small></strong></div>
        <div className="speed-board__track"><span style={{ width: `${speedProgress}%` }} /></div>
        <div className="speed-board__range"><span>{minSpeedKmh}</span><span>{maxSpeedKmh} km/h</span></div>
        <div className="speed-board__controls"><span><kbd>{compactKey(controls.left)}</kbd>/<kbd>{compactKey(controls.right)}</kbd> TURN</span><i>·</i><span><kbd>{compactKey(controls['speed-down'])}</kbd>/<kbd>{compactKey(controls['speed-up'])}</kbd> SPEED</span></div>
      </aside>

      <aside className="weapon-board" aria-label="Weapons and ammunition">
        <div className="weapon-board__item">
          <button type="button" key={`rocket-${weaponPress.type === 'rocket' ? weaponPress.serial : 0}`} className={`weapon-board__ammo weapon-board__ammo--rocket ${rocketReady ? 'weapon-board__ammo--available' : 'weapon-board__ammo--charging'} ${weaponPress.type === 'rocket' ? 'weapon-board__ammo--pressed' : ''}`} style={{ '--ammo-progress': `${ownPlayer.rocketPhase === 'preparing' ? rocketMeter * 100 : (ownPlayer.rocketAmmo >= ownPlayer.rocketCapacity ? 0 : (ownPlayer.rocketChargeProgress ?? 0) * 100)}%` }} onClick={() => { if (!rocketReady) return; setWeaponPress((current) => ({ type: 'rocket', serial: current.serial + 1 })); sendAction('launch-rocket'); }} disabled={!rocketReady} aria-label={`${ownPlayer.rocketAmmo} rockets available out of ${ownPlayer.rocketCapacity}`} title={`Rocket: ${Math.round(ownPlayer.rocketDamage ?? 0)} base damage, ${(ownPlayer.rocketPrepareMs ?? 1000) / 1000}s between shots, ${(ownPlayer.rocketChargeMs ?? 2300) / 1000}s ammo recharge. Press ${compactKey(controls.rocket)} or tap to launch.`}>
            <span className="weapon-board__weapon-icon" aria-hidden="true" style={weaponImageStyle({ type: 'rocket', variant: planeTierForLevel(ownPlayer) })} /><b key={`rocket-count-${ammoRechargePulse.rocket}`} className={ammoRechargePulse.rocket ? 'weapon-board__count--recharged' : ''}>{ownPlayer.rocketAmmo}</b><small>/{ownPlayer.rocketCapacity}</small><i aria-hidden="true" style={{ transform: `scaleX(${rocketMeter})` }} />
          </button>
          <span className="weapon-board__copy"><span className="weapon-board__action-heading"><kbd>{compactKey(controls.rocket)}</kbd><strong>ROCKETS</strong></span><small>DMG {Math.round(ownPlayer.rocketDamage ?? 0)}</small><small>PREP {((ownPlayer.rocketPrepareMs ?? 1000) / 1000).toFixed(1)}s</small><small>RECHARGE {((ownPlayer.rocketChargeMs ?? 2300) / 1000).toFixed(1)}s</small></span>
        </div>
        <div className="weapon-board__divider" />
        <div className="weapon-board__item">
          <button type="button" key={`mine-${weaponPress.type === 'mine' ? weaponPress.serial : 0}`} className={`weapon-board__ammo weapon-board__ammo--mine ${mineReady ? 'weapon-board__ammo--available' : 'weapon-board__ammo--charging'} ${weaponPress.type === 'mine' ? 'weapon-board__ammo--pressed' : ''}`} style={{ '--ammo-progress': `${ownPlayer.minePhase === 'preparing' ? mineMeter * 100 : (ownPlayer.mineAmmo >= ownPlayer.mineCapacity ? 0 : (ownPlayer.mineChargeProgress ?? 0) * 100)}%` }} onClick={() => { if (!mineReady) return; setWeaponPress((current) => ({ type: 'mine', serial: current.serial + 1 })); sendAction('drop-mine'); }} disabled={!mineReady} aria-label={`${ownPlayer.mineAmmo} mines available out of ${ownPlayer.mineCapacity}`} title={`Mine: ${Math.round(ownPlayer.mineDamage ?? 35)} base damage, ${(ownPlayer.minePrepareMs ?? 2000) / 1000}s between drops, ${(ownPlayer.mineChargeMs ?? 5000) / 1000}s ammo recharge. Press ${compactKey(controls.mine)} or tap to drop.`}>
            <span className="weapon-board__weapon-icon" aria-hidden="true" style={weaponImageStyle({ type: 'mine', variant: planeTierForLevel(ownPlayer) })} /><b key={`mine-count-${ammoRechargePulse.mine}`} className={ammoRechargePulse.mine ? 'weapon-board__count--recharged' : ''}>{ownPlayer.mineAmmo}</b><small>/{ownPlayer.mineCapacity}</small><i aria-hidden="true" style={{ transform: `scaleX(${mineMeter})` }} />
          </button>
          <span className="weapon-board__copy"><span className="weapon-board__action-heading"><kbd>{compactKey(controls.mine)}</kbd><strong>MINES</strong></span><small>DMG {Math.round(ownPlayer.mineDamage ?? 0)}</small><small>PREP {((ownPlayer.minePrepareMs ?? 2000) / 1000).toFixed(1)}s</small><small>RECHARGE {((ownPlayer.mineChargeMs ?? 5000) / 1000).toFixed(1)}s</small></span>
        </div>
        <div className="weapon-board__divider" />
        <div className="weapon-board__item weapon-board__item--fast" title={`Fast boost: lasts ${fastDurationSeconds} seconds, accelerates at 150 km/h per second up to 2× max speed, then decelerates at 250 km/h per second to your starting speed. Cooldown: ${(fastCooldownMs / 1000).toFixed(1)} seconds. Press again while active to stop. Use ${compactKey(controls.fast)}.`}>
          <button className={`weapon-board__ammo weapon-board__ammo--fast ${fastActiveRemainingMs > 0 ? 'weapon-board__ammo--fast-active' : ''}`} type="button" style={{ '--ammo-progress': `${fastCooldownRemainingMs > 0 ? fastReadyProgress * 100 : 0}%` }} onClick={() => sendAction('activate-fast')} disabled={fastCooldownRemainingMs > 0 && fastActiveRemainingMs <= 0} aria-label={`Fast boost; key ${compactKey(controls.fast)}; press again while active to stop`}>
            <span aria-hidden="true">⚡</span><b>1</b><small>/1</small><i className="weapon-board__fast-line" aria-hidden="true" style={{ transform: `scaleX(${fastReadyProgress})` }} /><span className="weapon-board__ammo-pips" aria-hidden="true">{Array.from({ length: 5 }, (_, index) => <i key={index} className={fastReadyProgress >= (index + 1) / 5 ? 'weapon-board__ammo-pip--filled' : ''} />)}</span>
          </button>
          <span className="weapon-board__copy"><span className="weapon-board__action-heading"><kbd>{compactKey(controls.fast)}</kbd><strong>FAST</strong></span><small>TIME {fastDurationSeconds}s</small></span>
        </div>
      </aside>

      <aside className="ranking-board" aria-label="Flight ranking">
        <strong className="ranking-board__title">FLIGHT RANKING</strong>
        {rankingPlayers.map((player, index) => <div className={`ranking-board__row ${player.id === playerId ? 'ranking-board__row--self' : ''}`} key={player.id}>
          <b>{index + 1}</b><span className="ranking-board__name">{player.name}{player.isBot && <small>BOT</small>}</span><span className="ranking-board__team" title={player.teamId ? teamLabel(player) : 'No team'}>{teamLabel(player)}</span><span className="ranking-board__level" title="Current level">L{player.level}</span><span className="ranking-board__kills" title="Kills since respawn">K{player.kills ?? 0}</span><strong title="Score">{player.score ?? 0}</strong>
        </div>)}
      </aside>

      {world && <aside className="mini-map" aria-label="Full map overview">
        <div className="mini-map__label">WORLD MAP</div>
        <div className="mini-map__surface">
          {visiblePlayers.filter((player) => player.id !== playerId).map((player) => <i className={`mini-map__other-player ${player.isBot ? 'mini-map__other-player--bot' : ''}`} key={player.id} style={{ left: `${(player.x / world.width) * 100}%`, top: `${(player.y / world.height) * 100}%` }} />)}
          <i className="mini-map__player" ref={miniPlayerRef} />
          <span className="mini-map__view" ref={miniViewRef} aria-hidden="true" style={{ width: `${miniMapViewWidth}%`, height: `${miniMapViewHeight}%` }} />
        </div>
      </aside>}
    </main>
  );
}
