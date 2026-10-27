import { useCallback, useEffect, useRef, useState } from 'react';
import Game from './Game.jsx';

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

const actions = [
  { label: 'Play', icon: '▶', variant: 'primary', description: 'Start a multiplayer flight' },
  { label: 'Train', icon: '✦', variant: 'secondary', description: 'Practice your flying' },
  { label: 'Help', icon: '?', variant: 'secondary', description: 'Learn how to play' },
];

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

export default function App() {
  const [status, setStatus] = useState('connecting');
  const [welcome, setWelcome] = useState('');
  const [playerName, setPlayerName] = useState(readPlayerName);
  const [nameDraft, setNameDraft] = useState(readPlayerName);
  const [nameModalOpen, setNameModalOpen] = useState(() => !readPlayerName());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('airplain-sound') !== 'off');
  const [controls, setControls] = useState(readControls);
  const [teamCode, setTeamCode] = useState(() => localStorage.getItem('airplain-team-code') || '');
  const [teamDamageEnabled, setTeamDamageEnabled] = useState(() => localStorage.getItem('airplain-team-damage') === 'on');
  const [listeningFor, setListeningFor] = useState('');
  const [keyError, setKeyError] = useState('');
  const [gamePage, setGamePage] = useState(false);
  const [world, setWorld] = useState(null);
  const [gameState, setGameState] = useState(null);
  const [playerId] = useState(readPlayerId);
  const socketRef = useRef(null);
  const pendingMessagesRef = useRef([]);
  const flightRef = useRef(null);

  const sendGameMessage = useCallback((message) => {
    if (message.type === 'join') flightRef.current = message;
    if (message.type === 'leave') flightRef.current = null;
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else if (message.type === 'join' || message.type === 'leave') pendingMessagesRef.current.push(message);
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
      localStorage.setItem('airplain-sound', current ? 'off' : 'on');
      return !current;
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
    let stopped = false;
    let retryMs = 1000;
    let retryTimer = 0;
    let socket;

    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(resolveWebSocketUrl());
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        if (stopped || socketRef.current !== socket) return;
        retryMs = 1000;
        setStatus('connected');
        const queued = pendingMessagesRef.current;
        pendingMessagesRef.current = [];
        for (const message of queued) socket.send(JSON.stringify(message));
        if (flightRef.current && !queued.some((message) => message.type === 'join')) socket.send(JSON.stringify(flightRef.current));
      });
      socket.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'welcome') setWelcome(data.message);
          if (data.type === 'world') setWorld(data.world);
          if (data.type === 'snapshot') setGameState(data);
        } catch {
          setWelcome(String(event.data));
        }
      });
      socket.addEventListener('close', () => {
        if (stopped || socketRef.current !== socket) return;
        setStatus('disconnected');
        retryTimer = window.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 10000);
      });
      socket.addEventListener('error', () => {
        if (!stopped && socketRef.current === socket) setStatus('connection error');
      });
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
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
        controls={controls}
        teamCode={teamCode}
        teamDamageEnabled={teamDamageEnabled}
        sendMessage={sendGameMessage}
        settingsOpen={settingsOpen}
        onBack={() => { sendGameMessage({ type: 'leave' }); setSettingsOpen(false); setGamePage(false); }}
        onSettings={() => { setSettingsOpen(true); setListeningFor(''); setKeyError(''); }}
      />
      {settingsOpen && <div className="game-settings-backdrop"><section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="game-settings-title">
        <button className="settings-panel__back menu__button--primary" type="button" onClick={() => { setSettingsOpen(false); setListeningFor(''); setKeyError(''); }}><span aria-hidden="true">←</span> Back to flight</button>
        <div className="settings-panel__heading"><span className="settings-panel__eyebrow">FLIGHT CONTROLS</span><h1 id="game-settings-title">Settings</h1><p>Change keys without leaving your flight.</p></div>
        <div className="controls-list">{controlLabels.map(([name, label]) => <div className="control-row" key={name}><span className="control-row__label">{label}</span><button className={`key-button ${listeningFor === name ? 'key-button--listening' : ''}`} type="button" onClick={() => { setListeningFor(name); setKeyError(''); }} aria-label={`Set key for ${label}, currently ${formatKey(controls[name])}`}>{listeningFor === name ? 'PRESS A KEY' : formatKey(controls[name])}</button></div>)}</div>
        <div className="team-settings">
          <label className="team-settings__code">Team code <input maxLength={24} value={teamCode} placeholder="Leave blank for no team (-)" onChange={(event) => { const value = event.target.value.slice(0, 24); setTeamCode(value); localStorage.setItem('airplain-team-code', value); }} /></label>
          <label className="team-settings__toggle"><input type="checkbox" checked={teamDamageEnabled} onChange={(event) => { const enabled = event.target.checked; setTeamDamageEnabled(enabled); localStorage.setItem('airplain-team-damage', enabled ? 'on' : 'off'); }} /><span>Allow team damage (50%)</span></label>
          <small>Players with the same code share a team. A blank code means no team; bots also have no team.</small>
        </div>
        <p className="settings-panel__hint" aria-live="polite">{keyError || (listeningFor ? 'Press a key to assign it. Escape cancels.' : 'Select a key to change its binding.')}</p>
      </section></div>}
    </>;
  }

  return (
    <main className="landing" aria-label="Air Plain Multiplayer">
      <div className="landing__shade" aria-hidden="true" />
      <div className="top-actions" aria-label="Quick settings">
        <button className={`top-actions__button ${soundOn ? '' : 'top-actions__button--muted'}`} type="button" onClick={toggleSound} aria-label={soundOn ? 'Turn sound off' : 'Turn sound on'} aria-pressed={soundOn} title={soundOn ? 'Sound on' : 'Sound off'}>
          {soundOn ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9a5 5 0 0 1 0 6M18.5 6.5a9 9 0 0 1 0 11" /></svg> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="m17 9 5 6m0-6-5 6" /></svg>}
        </button>
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
          {actions.map(({ label, icon, variant, description }) => (
            <button
              className={`menu__button menu__button--${variant}`}
              key={label}
              type="button"
              aria-label={`${label}: ${description}`}
              onClick={label === 'Play' ? () => setGamePage(true) : undefined}
            >
              <span className="menu__icon" aria-hidden="true">{icon}</span>
              <span>{label}</span>
              <span className="menu__shine" aria-hidden="true" />
            </button>
          ))}
        </nav>

        <div className="connection" aria-live="polite">
          <span className={`connection__dot connection__dot--${status === 'connected' ? 'online' : 'idle'}`} />
          <span>{welcome || (status === 'connected' ? 'Ready for takeoff' : 'Connecting to flight control')}</span>
        </div>
      </div> : <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button className="settings-panel__back menu__button--primary" type="button" onClick={() => { setSettingsOpen(false); setListeningFor(''); setKeyError(''); }}>
          <span aria-hidden="true">←</span> Back
        </button>
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
        <div className="team-settings">
          <label className="team-settings__code">Team code <input maxLength={24} value={teamCode} placeholder="Leave blank for no team (-)" onChange={(event) => { const value = event.target.value.slice(0, 24); setTeamCode(value); localStorage.setItem('airplain-team-code', value); }} /></label>
          <label className="team-settings__toggle"><input type="checkbox" checked={teamDamageEnabled} onChange={(event) => { const enabled = event.target.checked; setTeamDamageEnabled(enabled); localStorage.setItem('airplain-team-damage', enabled ? 'on' : 'off'); }} /><span>Allow team damage (50%)</span></label>
          <small>Players with the same code share a team. A blank code means no team; bots also have no team.</small>
        </div>
        <p className="settings-panel__hint" aria-live="polite">{keyError || (listeningFor ? 'Press any key to assign it. Press Escape to cancel.' : 'Select a key to change its binding.')}</p>
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
