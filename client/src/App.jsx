import { useCallback, useEffect, useRef, useState } from 'react';
import Game from './Game.jsx';
import SoundButton from './SoundButton.jsx';
import { setSoundEnabled, startBackground } from './audio.js';
import { createNetState, decodeSnapshot, noteBytes, noteMeta, notePong } from './net.js';

const hudPublishMs = 100;
const pingMs = 2000;
const socketRotateMs = 280000;

const configuredWebSocketUrl = import.meta.env.VITE_WEBSOCKET_URL;
function resolveWebSocketUrl() {
  if (configuredWebSocketUrl) return configuredWebSocketUrl;
  if (typeof window === 'undefined') return 'ws://localhost:3001/ws';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (!import.meta.env.PROD) {
    const hostname = window.location.hostname || 'localhost';
    return protocol + '//' + hostname + ':3001/ws';
  }
  const socketPath = import.meta.env.VITE_VERCEL === '1' ? '/api/server' : '/ws';
  return protocol + '//' + window.location.host + socketPath;
}

const githubVoteUrl = 'https://github.com/proteus1208/node-air-craft-multiplayer-game-v2';
const githubRepoApiUrl = 'https://api.github.com/repos/proteus1208/node-air-craft-multiplayer-game-v2';

function formatVoteCount(count) {
  let rounded = Math.max(0, Math.round(count));
  const units = ['', 'K', 'M', 'B'];
  let unit = 0;
  while (rounded >= 1000 && unit < units.length - 1) {
    rounded = Math.round(rounded / 1000);
    unit += 1;
  }
  return `${rounded}${units[unit]}`;
}

const defaultControls = {
  left: 'A',
  right: 'D',
  'speed-up': 'W',
  'speed-down': 'S',
  rocket: 'J',
  mine: 'K',
  fast: 'L',
};

const controlLabels = [
  ['left', 'Left'],
  ['right', 'Right'],
  ['speed-up', 'Speed up'],
  ['speed-down', 'Speed down'],
  ['rocket', 'Launch rocket'],
  ['mine', 'Drop mine'],
  ['fast', 'Timed fast boost'],
];

function readControls() {
  try {
    return { ...defaultControls, ...JSON.parse(localStorage.getItem('airplain-controls') || '{}') };
  } catch {
    return defaultControls;
  }
}

function formatKey(key) {
  if (key === ' ') return 'SPACE';
  if (key.startsWith('Arrow')) return key.replace('Arrow', '').toUpperCase();
  return key.length === 1 ? key.toUpperCase() : key.toUpperCase();
}

function readPlayerName() {
  return localStorage.getItem('airplain-player-name')?.trim() || '';
}

function readPlayerId() {
  let id = sessionStorage.getItem('airplain-player-id');
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `pilot-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('airplain-player-id', id);
  }
  return id;
}

function readVisitorId() {
  let id = localStorage.getItem('airplain-visitor-id');
  if (!id || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) {
    id = globalThis.crypto?.randomUUID?.() || `visitor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem('airplain-visitor-id', id);
  }
  return id;
}

function readRoomId() {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('room') || '';
}

function writeRoomId(id) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('room', id);
  else url.searchParams.delete('room');
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

export default function App() {
  const [status, setStatus] = useState('connecting');
  const [welcome, setWelcome] = useState('');
  const [playerName, setPlayerName] = useState(readPlayerName);
  const [nameDraft, setNameDraft] = useState(readPlayerName);
  const [nameModalOpen, setNameModalOpen] = useState(() => !readPlayerName());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('airplain-sound') !== 'off');
  const [controls, setControls] = useState(readControls);
  const [listeningFor, setListeningFor] = useState('');
  const [keyError, setKeyError] = useState('');
  const [gamePage, setGamePage] = useState(() => Boolean(readRoomId()));
  const [roomId, setRoomId] = useState(readRoomId);
  const [roomInfo, setRoomInfo] = useState(null);
  const [roomError, setRoomError] = useState('');
  const [teamReady, setTeamReady] = useState(false);
  const [teamChoice, setTeamChoice] = useState('');
  const [joinPassword, setJoinPassword] = useState('');
  const [customName, setCustomName] = useState('');
  const [customPassword, setCustomPassword] = useState('');
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [voteCount, setVoteCount] = useState(null);
  const [visitors, setVisitors] = useState(null);
  const [world, setWorld] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [playerId] = useState(readPlayerId);
  const socketRef = useRef(null);
  const pendingMessagesRef = useRef([]);
  const flightRef = useRef(null);
  const netRef = useRef(null);
  const roomIdRef = useRef(readRoomId());
  const acceptRoomRef = useRef(Boolean(readRoomId()));
  if (!netRef.current) netRef.current = createNetState();

  const sendGameMessage = useCallback((message) => {
    if (message.type === 'join') flightRef.current = message;
    if (message.type === 'leave') flightRef.current = null;
    const socket = socketRef.current;
    const queued = message.type === 'join' || message.type === 'leave' || message.type === 'create-room' || message.type === 'room-info' || message.type === 'create-team';
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else if (queued) pendingMessagesRef.current.push(message);
  }, []);

  useEffect(() => {
    if (!listeningFor) return undefined;
    const captureKey = (event) => {
      event.preventDefault();
      if (event.key === 'Escape') {
        setListeningFor('');
        setKeyError('');
        return;
      }
      if (event.key.length !== 1 && !event.key.startsWith('Arrow') && event.key !== ' ') return;

      const key = event.key === ' ' ? ' ' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
      const duplicate = controlLabels.find(([name]) => name !== listeningFor && controls[name].toLowerCase() === key.toLowerCase());
      if (duplicate) {
        setKeyError(`${formatKey(key)} is already assigned to ${duplicate[1]}.`);
        return;
      }

      const nextControls = { ...controls, [listeningFor]: key };
      setControls(nextControls);
      localStorage.setItem('airplain-controls', JSON.stringify(nextControls));
      setListeningFor('');
      setKeyError('');
    };
    window.addEventListener('keydown', captureKey);
    return () => window.removeEventListener('keydown', captureKey);
  }, [listeningFor, controls]);

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !listeningFor) setSettingsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [listeningFor]);

  const toggleSound = () => {
    setSoundOn((current) => {
      const next = !current;
      localStorage.setItem('airplain-sound', next ? 'on' : 'off');
      setSoundEnabled(next);
      if (next) startBackground();
      return next;
    });
  };

  const savePlayerName = (event) => {
    event.preventDefault();
    const name = nameDraft.trim().slice(0, 24);
    if (!name) return;
    localStorage.setItem('airplain-player-name', name);
    setPlayerName(name);
    setNameModalOpen(false);
  };

  useEffect(() => {
    setSoundEnabled(soundOn);
    const unlock = () => startBackground();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [soundOn]);

  useEffect(() => {
    let cancelled = false;
    fetch(githubRepoApiUrl)
      .then((response) => (response.ok ? response.json() : null))
      .then((repo) => {
        if (!cancelled && Number.isFinite(repo?.stargazers_count)) setVoteCount(repo.stargazers_count);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let stopped = false;
    let retryMs = 1000;
    let retryTimer = 0;
    let rotateTimer = 0;
    let lastPublishAt = 0;
    let lastStructure = '';
    const retired = new WeakSet();
    const net = netRef.current;

    const publish = (decoded, now) => {
      const structure = decoded.players.map((player) => player.id + (player.hp > 0 ? '+' : '-')).join()
        + '|' + decoded.rockets.map((rocket) => rocket.id).join()
        + '|' + decoded.mines.map((mine) => mine.id + (mine.armed ? '+' : '-')).join()
        + '|' + decoded.blasts.map((blast) => blast.id).join();
      if (structure === lastStructure && now - lastPublishAt < hudPublishMs) return;
      lastStructure = structure;
      lastPublishAt = now;
      const ownId = flightRef.current?.id;
      const players = net.hud && ownId ? decoded.players.map((player) => (player.id === ownId ? { ...player, ...net.hud, x: player.x, y: player.y, angle: player.angle, hp: player.hp, level: player.level, kills: player.kills, score: player.score, name: player.name, teamId: player.teamId, teamName: player.teamName, teamColor: player.teamColor, mark: player.mark } : player)) : decoded.players;
      setGameState({ ...decoded, players, hunt: net.hunt || '' });
    };

    const handleMessage = (event) => {
      const now = performance.now();
      noteBytes(net, event.data.length ?? 0, now);
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        setWelcome(String(event.data));
        return;
      }
      if (data.type === 's') publish(decodeSnapshot(net, data, now), now);
      else if (data.type === 'meta') {
        noteMeta(net, data.p, data.h);
        setGameState((current) => (current ? { ...current, hunt: data.h || '' } : current));
      }
      else if (data.type === 'pong') notePong(net, data.c, now);
      else if (data.type === 'room') {
        if (!acceptRoomRef.current) return;
        if (data.roomId) {
          roomIdRef.current = data.roomId;
          setRoomId(data.roomId);
          writeRoomId(data.roomId);
        }
        setRoomInfo(data);
        setRoomError('');
        setGamePage(true);
        if (data.joinedTeam) {
          setTeamChoice(data.joinedTeam);
          setCreatingTeam(false);
          setCustomName('');
          setCustomPassword('');
        }
      }
      else if (data.type === 'room-error') {
        setRoomError(data.message || 'Could not open that room.');
        if (flightRef.current) {
          acceptRoomRef.current = false;
          setTeamReady(false);
          setGamePage(false);
        }
      }
      else if (data.type === 'welcome') setWelcome(data.message);
      else if (data.type === 'world') setWorld(data.world);
      else if (data.type === 'visitors' && Number.isFinite(data.today) && Number.isFinite(data.current)) setVisitors({ today: data.today, current: data.current });
    };

    const scheduleRetry = () => {
      setStatus('reconnecting');
      window.clearTimeout(rotateTimer);
      retryTimer = window.setTimeout(() => openSocket(false), retryMs);
      retryMs = Math.min(retryMs * 2, 10000);
    };

    // Vercel closes a socket when its function reaches maxDuration, so a fresh
    // socket is opened shortly before that and swapped in once it is ready.
    const openSocket = (rotating) => {
      if (stopped) return;
      const next = new WebSocket(resolveWebSocketUrl());
      if (!rotating) socketRef.current = next;
      next.addEventListener('open', () => {
        if (stopped) { next.close(); return; }
        const previous = socketRef.current;
        socketRef.current = next;
        if (previous && previous !== next) {
          retired.add(previous);
          previous.close();
        }
        retryMs = 1000;
        setStatus('connected');
        next.send(JSON.stringify({ type: 'visit', id: readVisitorId() }));
        const queued = pendingMessagesRef.current;
        pendingMessagesRef.current = [];
        for (const message of queued) next.send(JSON.stringify(message));
        if (flightRef.current && !queued.some((message) => message.type === 'join')) next.send(JSON.stringify(flightRef.current));
        if (roomIdRef.current && !flightRef.current && !queued.some((message) => message.type === 'room-info' || message.type === 'create-room')) next.send(JSON.stringify({ type: 'room-info', roomId: roomIdRef.current }));
        next.send(JSON.stringify({ type: 'ping', c: performance.now() }));
        window.clearTimeout(rotateTimer);
        rotateTimer = window.setTimeout(() => openSocket(true), socketRotateMs);
      });
      next.addEventListener('message', (event) => {
        if (socketRef.current === next) handleMessage(event);
      });
      next.addEventListener('close', () => {
        if (stopped || retired.has(next) || socketRef.current !== next) return;
        scheduleRetry();
      });
      next.addEventListener('error', () => {
        if (!stopped && socketRef.current === next && next.readyState !== WebSocket.OPEN) setStatus('reconnecting');
      });
    };

    const pingTimer = window.setInterval(() => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', c: performance.now() }));
    }, pingMs);

    openSocket(false);
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      window.clearTimeout(rotateTimer);
      window.clearInterval(pingTimer);
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
  }, []);

  if (gamePage) {
    return <>
      <Game
        world={world}
        playerName={playerName}
        playerId={playerId}
        gameState={gameState}
        net={netRef.current}
        connectionStatus={status}
        controls={controls}
        roomId={roomId}
        team={teamChoice}
        teamPassword={joinPassword}
        flying={teamReady}
        sendMessage={sendGameMessage}
        settingsOpen={settingsOpen || !teamReady}
        soundOn={soundOn}
        onToggleSound={toggleSound}
        onBack={() => { acceptRoomRef.current = false; sendGameMessage({ type: 'leave' }); setSettingsOpen(false); setTeamReady(false); setGamePage(false); setRoomInfo(null); setRoomError(''); setCreatingTeam(false); roomIdRef.current = ''; setRoomId(''); writeRoomId(''); }}
        onSettings={() => { setSettingsOpen(true); setListeningFor(''); setKeyError(''); }}
      />
      {!teamReady && <div className="game-settings-backdrop team-gate">
        <section className="settings-panel room-lobby" aria-label={roomId ? 'Custom room' : 'Public match'}>
          <button className="settings-panel__back menu__button--primary" type="button" onClick={() => { acceptRoomRef.current = false; sendGameMessage({ type: 'leave' }); setTeamReady(false); setGamePage(false); setRoomInfo(null); setRoomError(''); setCreatingTeam(false); roomIdRef.current = ''; setRoomId(''); writeRoomId(''); }}><span aria-hidden="true">←</span> Back</button>
          <div className="settings-panel__scroll">
            <div className="settings-panel__heading">
              <span className="settings-panel__eyebrow">{roomId ? 'PRIVATE ROOM' : 'PUBLIC MATCH'}</span>
              <h1>Choose your team</h1>
              <p>{roomId ? 'Share this link. Anyone who opens it joins this room.' : 'Pick a side, then take off.'}</p>
            </div>
            {roomId && <>
              <label className="room-lobby__link">Room link
                <input readOnly value={`${window.location.origin}${window.location.pathname}?room=${roomId}`} onFocus={(event) => event.target.select()} />
              </label>
              <button className="menu__button menu__button--secondary room-lobby__copy" type="button" onClick={() => { const link = `${window.location.origin}${window.location.pathname}?room=${roomId}`; navigator.clipboard?.writeText(link).then(() => setLinkCopied(true)).catch(() => setLinkCopied(false)); }}>
                {linkCopied ? 'Link copied' : 'Copy room link'}
              </button>
            </>}
            {!roomInfo ? <p className="room-lobby__status">Opening the map…</p> : <>
              <div className="room-teams">
                {['a', 'b'].map((id) => {
                  const team = roomInfo.teams.find((item) => item.id === id);
                  if (!team) return null;
                  return <button className={`menu__button menu__button--color ${teamChoice === team.id ? 'menu__button--selected' : ''}`} style={{ '--button-bg': team.color }} type="button" key={team.id} onClick={() => { setTeamChoice(team.id); setCreatingTeam(false); setRoomError(''); }}>
                    <span>{team.name}</span>
                    <small>{team.members} {team.members === 1 ? 'pilot' : 'pilots'}</small>
                    <span className="menu__shine" aria-hidden="true" />
                  </button>;
                })}
                <button className={`menu__button menu__button--color ${teamChoice === 'solo' ? 'menu__button--selected' : ''}`} style={{ '--button-bg': '#5f8fb3' }} type="button" onClick={() => { setTeamChoice('solo'); setCreatingTeam(false); setRoomError(''); }}>
                  <span>Individual</span>
                  <small>No team</small>
                  <span className="menu__shine" aria-hidden="true" />
                </button>
                <button className={`menu__button menu__button--color ${creatingTeam ? 'menu__button--selected' : ''}`} style={{ '--button-bg': '#e0a12a' }} type="button" onClick={() => { setCreatingTeam((open) => !open); setRoomError(''); }}>
                  <span>{creatingTeam ? 'Close' : 'Create team'}</span>
                  <small>Custom color</small>
                  <span className="menu__shine" aria-hidden="true" />
                </button>
              </div>
              {roomInfo.teams.some((team) => team.id !== 'a' && team.id !== 'b') && <div className="room-teams room-teams--extra">
                {roomInfo.teams.filter((team) => team.id !== 'a' && team.id !== 'b').map((team) => <button className={`menu__button menu__button--color ${teamChoice === team.id ? 'menu__button--selected' : ''}`} style={{ '--button-bg': team.color }} type="button" key={team.id} onClick={() => { setTeamChoice(team.id); setCreatingTeam(false); setRoomError(''); }}>
                  <span>{team.name}</span>
                  <small>{team.members} {team.members === 1 ? 'pilot' : 'pilots'}{team.locked ? ' · locked' : ''}</small>
                  <span className="menu__shine" aria-hidden="true" />
                </button>)}
              </div>}
              {roomInfo.teams.some((team) => team.id === teamChoice && team.locked) && <label className="room-lobby__link">Team password
                <input type="password" maxLength={32} value={joinPassword} placeholder="Password for this team" onChange={(event) => setJoinPassword(event.target.value)} />
              </label>}
              {creatingTeam && <form className="room-create-team" onSubmit={(event) => { event.preventDefault(); if (!customName.trim()) { setRoomError('Enter a team name.'); return; } setJoinPassword(customPassword); setRoomError(''); sendGameMessage({ type: 'create-team', roomId: roomId || 'public', name: customName.trim(), password: customPassword }); }}>
                <input maxLength={24} value={customName} placeholder="Team name" onChange={(event) => setCustomName(event.target.value)} />
                <input type="password" maxLength={32} value={customPassword} placeholder="Password (optional)" onChange={(event) => setCustomPassword(event.target.value)} />
                <button className="menu__button menu__button--primary" type="submit"><span>Create team</span><span className="menu__shine" aria-hidden="true" /></button>
              </form>}
              <button className="menu__button menu__button--primary" type="button" disabled={!roomInfo || !teamChoice} onClick={() => {
                if (!playerName) { setNameDraft(''); setNameModalOpen(true); return; }
                const selected = roomInfo.teams.find((team) => team.id === teamChoice);
                if (selected?.locked && !joinPassword) { setRoomError('Enter the team password.'); return; }
                setRoomError('');
                setTeamReady(true);
              }}><span className="menu__icon" aria-hidden="true">▶</span><span>Take off</span><span className="menu__shine" aria-hidden="true" /></button>
            </>}
            {roomError && <p className="room-lobby__error" role="alert">{roomError}</p>}
          </div>
        </section>
      </div>}
      {settingsOpen && <div className="game-settings-backdrop"><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="game-settings-title">
        <button className="settings-panel__back menu__button--primary" type="button" onClick={() => { setSettingsOpen(false); setListeningFor(''); setKeyError(''); }}><span aria-hidden="true">←</span> Back to flight</button>
        <div className="settings-panel__scroll">
        <div className="settings-panel__heading"><span className="settings-panel__eyebrow">FLIGHT CONTROLS</span><h1 id="game-settings-title">Settings</h1><p>Change keys without leaving your flight.</p></div>
        <div className="controls-list">{controlLabels.map(([name, label]) => <div className="control-row" key={name}><span className="control-row__label">{label}</span><button className={`key-button ${listeningFor === name ? 'key-button--listening' : ''}`} type="button" onClick={() => { setListeningFor(name); setKeyError(''); }} aria-label={`Set key for ${label}, currently ${formatKey(controls[name])}`}>{listeningFor === name ? 'PRESS A KEY' : formatKey(controls[name])}</button></div>)}</div>
        <p className="settings-panel__hint" aria-live="polite">{keyError || (listeningFor ? 'Press a key to assign it. Escape cancels.' : 'Select a key to change its binding.')}</p>
        </div>
      </section></div>}
      {nameModalOpen && <div className="name-modal-backdrop">
        <section className="name-modal" role="dialog" aria-modal="true" aria-labelledby="name-modal-title">
          <span className="name-modal__badge" aria-hidden="true">✦</span>
          <span className="name-modal__eyebrow">{playerName ? 'PILOT PROFILE' : 'READY FOR TAKEOFF?'}</span>
          <h1 id="name-modal-title">{playerName ? 'Edit your name' : 'What should we call you?'}</h1>
          <p>{playerName ? 'Choose a new name for your landing screen.' : 'Your name will appear above your plane.'}</p>
          <form className="name-form" onSubmit={savePlayerName}>
            <label className="name-form__label" htmlFor="player-name-flight">Pilot name</label>
            <input autoFocus autoComplete="nickname" id="player-name-flight" className="name-form__input" maxLength={24} name="playerName" onChange={(event) => setNameDraft(event.target.value)} placeholder="Enter your name" value={nameDraft} />
            <button className="menu__button menu__button--primary name-form__submit" type="submit" disabled={!nameDraft.trim()}>
              <span className="menu__icon" aria-hidden="true">▶</span>
              <span>{playerName ? 'Save name' : 'Let’s fly!'}</span>
              <span className="menu__shine" aria-hidden="true" />
            </button>
          </form>
        </section>
      </div>}
    </>;
  }

  return (
    <main className="landing" aria-label="Air Plain Multiplayer">
      <div className="landing__shade" aria-hidden="true" />
      <div className="top-actions" aria-label="Quick settings">
        <a className="top-actions__button top-actions__vote" href={githubVoteUrl} target="_blank" rel="noopener noreferrer" aria-label={voteCount !== null ? `Vote: star this game on GitHub, ${formatVoteCount(voteCount)} stars` : 'Vote: star this game on GitHub'} title="Star this game on GitHub">
          <span aria-hidden="true">★</span>
          <span>Vote</span>
          {voteCount !== null && <span className="top-actions__votes">{formatVoteCount(voteCount)}</span>}
        </a>
        <SoundButton soundOn={soundOn} onClick={toggleSound} />
        <button className="top-actions__button" type="button" onClick={() => { setSettingsOpen(true); setListeningFor(''); setKeyError(''); }} aria-label="Open settings" title="Settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.95l-.36-2.54A.49.49 0 0 0 13.88 2h-3.76a.49.49 0 0 0-.49.42L9.27 4.96c-.6.24-1.14.56-1.63.95l-2.39-.96a.5.5 0 0 0-.61.22L2.72 8.49a.5.5 0 0 0 .12.64l2.03 1.58a6.5 6.5 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.12.21.37.3.61.22l2.39-.96c.49.39 1.03.71 1.63.95l.36 2.54c.03.24.24.42.49.42h3.76c.25 0 .46-.18.49-.42l.36-2.54c.6-.24 1.14-.56 1.63-.95l2.39.96c.24.09.49 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.02-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>
        </button>
      </div>

      {!settingsOpen ? <div className="landing__content">
        <img
          className="landing__logo"
          src="/assets/title.png"
          alt="Air Plain Multiplayer"
        />

        {playerName && <p className="player-greeting">
          <span>Hello {playerName}!</span>
          <button className="player-greeting__edit" type="button" aria-label="Edit your name" title="Edit name" onClick={() => { setNameDraft(playerName); setNameModalOpen(true); }}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5.5 4 4M4 20l4.2-.9L19.1 8.2a2.1 2.1 0 0 0-3-3L5.2 16.1 4 20Z" /></svg>
          </button>
        </p>}

        <nav className="menu" aria-label="Main menu">
          <button className="menu__button menu__button--primary" type="button" aria-label="Play: Start a multiplayer flight" onClick={() => { if (!playerName) { setNameModalOpen(true); return; } acceptRoomRef.current = true; roomIdRef.current = ''; setRoomId(''); writeRoomId(''); setTeamChoice(''); setTeamReady(false); setRoomInfo(null); setRoomError(''); setCreatingTeam(false); setGameState(null); setGamePage(true); sendGameMessage({ type: 'room-info', roomId: 'public' }); }}>
            <span className="menu__icon" aria-hidden="true">▶</span>
            <span>Play</span>
            <span className="menu__shine" aria-hidden="true" />
          </button>
          <button className="menu__button menu__button--secondary" type="button" onClick={() => { if (!playerName) { setNameModalOpen(true); return; } acceptRoomRef.current = true; roomIdRef.current = ''; setRoomId(''); writeRoomId(''); setTeamChoice(''); setTeamReady(false); setRoomInfo(null); setRoomError(''); setCreatingTeam(false); setLinkCopied(false); setGameState(null); setGamePage(true); sendGameMessage({ type: 'create-room' }); }}>
            <span>Create room</span>
          </button>
        </nav>

        <div className="visitors" aria-live="polite" aria-label="Visitor counts">
          <span>Today <strong>{visitors ? formatVoteCount(visitors.today) : '—'}</strong></span>
          <span>Now <strong>{visitors ? formatVoteCount(visitors.current) : '—'}</strong></span>
        </div>

        <div className="connection" aria-live="polite">
          <span className={`connection__dot connection__dot--${status === 'connected' ? 'online' : 'idle'}`} />
          <span>{welcome || (status === 'connected' ? 'Ready for takeoff' : 'Connecting to flight control')}</span>
        </div>
      </div> : null}
      {settingsOpen && <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button className="settings-panel__back menu__button--primary" type="button" onClick={() => { setSettingsOpen(false); setListeningFor(''); setKeyError(''); }}>
          <span aria-hidden="true">←</span> Back
        </button>
        <div className="settings-panel__scroll">
        <div className="settings-panel__heading">
          <span className="settings-panel__eyebrow">FLIGHT CONTROLS</span>
          <h1 id="settings-title">Settings</h1>
          <p>Choose the keys that feel right for your flight.</p>
        </div>
        <div className="controls-list">
          {controlLabels.map(([name, label]) => (
            <div className="control-row" key={name}>
              <span className="control-row__label">{label}</span>
              <button className={`key-button ${listeningFor === name ? 'key-button--listening' : ''}`} type="button" onClick={() => { setListeningFor(name); setKeyError(''); }} aria-label={`Set key for ${label}, currently ${formatKey(controls[name])}`}>
                {listeningFor === name ? 'PRESS A KEY' : formatKey(controls[name])}
              </button>
            </div>
          ))}
        </div>
        <p className="settings-panel__hint" aria-live="polite">{keyError || (listeningFor ? 'Press any key to assign it. Press Escape to cancel.' : 'Select a key to change its binding.')}</p>
        </div>
      </section>}
      <span className="landing__version" aria-hidden="true">AIR PLAIN · MULTIPLAYER</span>
      {nameModalOpen && <div className="name-modal-backdrop">
        <section className="name-modal" role="dialog" aria-modal="true" aria-labelledby="name-modal-title">
          <span className="name-modal__badge" aria-hidden="true">✦</span>
          <span className="name-modal__eyebrow">{playerName ? 'PILOT PROFILE' : 'READY FOR TAKEOFF?'}</span>
          <h1 id="name-modal-title">{playerName ? 'Edit your name' : 'What should we call you?'}</h1>
          <p>{playerName ? 'Choose a new name for your landing screen.' : 'Your name will appear on your landing screen.'}</p>
          <form className="name-form" onSubmit={savePlayerName}>
            <label className="name-form__label" htmlFor="player-name">Pilot name</label>
            <input
              autoFocus
              autoComplete="nickname"
              id="player-name"
              className="name-form__input"
              maxLength={24}
              name="playerName"
              onChange={(event) => setNameDraft(event.target.value)}
              placeholder="Enter your name"
              value={nameDraft}
            />
            <button className="menu__button menu__button--primary name-form__submit" type="submit" disabled={!nameDraft.trim()}>
              <span className="menu__icon" aria-hidden="true">▶</span>
              <span>{playerName ? 'Save name' : 'Let’s fly!'}</span>
              <span className="menu__shine" aria-hidden="true" />
            </button>
          </form>
        </section>
      </div>}
    </main>
  );
}
