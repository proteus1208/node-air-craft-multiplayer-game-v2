import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MAX_LEVEL, fixed, levelStats } from './balance.js';

if (process.argv.includes('--serve-client')) process.env.NODE_ENV = 'production';

const port = Number(process.env.PORT ?? 3001);
const clientDist = join(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
const clientDistRoot = normalize(clientDist + sep);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function serveClient(req, res, url) {
  const requested = decodeURIComponent(url.pathname);
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  let target = normalize(join(clientDist, relative));
  if (target !== normalize(clientDist) && !target.startsWith(clientDistRoot)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  const fileReady = existsSync(target) && statSync(target).isFile();
  if (!fileReady) {
    if (extname(relative)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    target = join(clientDist, 'index.html');
    if (!existsSync(target)) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Client build missing. Run npm run build.');
      return;
    }
  }
  const type = contentTypes[extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': target.endsWith(`${sep}index.html`) ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

function requestListener(req, res) {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/health' || url.pathname === '/api/server') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    if (process.env.NODE_ENV === 'production' && !process.env.VERCEL) serveClient(req, res, url);
    else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
  }
}

const httpServer = createServer(requestListener);
const server = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname !== '/' && pathname !== '/ws' && pathname !== '/api/server') {
    socket.destroy();
    return;
  }
  server.handleUpgrade(request, socket, head, (ws) => {
    server.emit('connection', ws, request);
  });
});

// A single fixed world is generated when the server starts, then shared with
// every client that joins this server process.
const world = createWorld();
const players = new Map();
const rockets = [];
const mines = [];
const blasts = [];
let nextBotId = 1;
let lastTickAt = Date.now();
let lastBroadcastAt = 0;

function createWorld() {
  const width = fixed('worldWidth');
  const height = fixed('worldHeight');
  const margin = fixed('featureMargin');
  let seed = fixed('worldSeed');
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const clouds = Array.from({ length: fixed('cloudCount') }, (_, index) => ({
    id: `cloud-${index}`,
    type: 'cloud',
    x: fixed('cloudMarginX') + random() * (width - fixed('cloudMarginX') * 2),
    y: fixed('cloudMarginY') + random() * (height - fixed('cloudMarginY') * 2),
    size: fixed('cloudSizeMin') + random() * (fixed('cloudSizeMax') - fixed('cloudSizeMin')),
    variant: Math.floor(random() * fixed('variantCount')) + 1,
  }));
  // Place land features with a shared clearance radius so flowers, trees,
  // rocks, and lakes don't overlap or hide each other.
  const objects = [];
  const placeObjects = (type, count, sizeMin, sizeMax, clearance) => {
    for (let index = 0; index < count; index += 1) {
      let point = null;
      for (let attempt = 0; attempt < fixed('featurePlaceAttempts'); attempt += 1) {
        const candidate = {
          x: margin + random() * (width - margin * 2),
          y: margin + random() * (height - margin * 2),
        };
        if (objects.every((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) >= clearance)) {
          point = candidate;
          break;
        }
      }
      if (!point) continue;
      objects.push({
        id: `${type}-${index}`,
        type,
        ...point,
        size: sizeMin + random() * (sizeMax - sizeMin),
        variant: Math.floor(random() * fixed('variantCount')) + 1,
      });
    }
  };
  placeObjects('tree', fixed('treeCount'), fixed('treeSizeMin'), fixed('treeSizeMax'), fixed('treeClearance'));
  placeObjects('flower', fixed('flowerCount'), fixed('flowerSizeMin'), fixed('flowerSizeMax'), fixed('flowerClearance'));
  placeObjects('rock', fixed('rockCount'), fixed('rockSizeMin'), fixed('rockSizeMax'), fixed('rockClearance'));
  placeObjects('pool', fixed('lakeCount'), fixed('lakeSizeMin'), fixed('lakeSizeMax'), fixed('lakeClearance'));

  return { width, height, clouds, objects };
}

function getEffectiveTeamId(player) {
  return player.level >= MAX_LEVEL ? `team:level-${MAX_LEVEL}` : player.teamId;
}

function mineSlowDepth(player, now = Date.now()) {
  if (!player.mineSlowUntil || now >= player.mineSlowUntil) return 0;
  const duration = Math.max(1, player.mineSlowDurationMs || 1);
  const elapsed = Math.max(0, Math.min(1, (now - player.mineSlowStartedAt) / duration));
  const ramp = 0.3;
  const depth = elapsed < ramp ? elapsed / ramp : (elapsed > 1 - ramp ? (1 - elapsed) / ramp : 1);
  return depth * depth * (3 - 2 * depth);
}

function applyMineSlow(player, now, durationMs) {
  const ramp = 0.3;
  const alreadySlow = player.mineSlowUntil && now < player.mineSlowUntil;
  player.mineSlowDurationMs = durationMs;
  player.mineSlowStartedAt = alreadySlow ? now - ramp * durationMs : now;
  player.mineSlowUntil = player.mineSlowStartedAt + durationMs;
}

function getSpeedKmh(player, now = Date.now()) {
  const depth = mineSlowDepth(player, now);
  if (depth <= 0) return Math.round(player.speed);
  const stats = levelStats(player.level);
  // Mine slow eases airspeed to minimum / 2. Fast is a 2x activity, so both
  // together fly at minimum speed. Stored speed still climbs during the boost,
  // and that 2x top speed is what remains after the slow ends.
  const slowedTarget = now < player.fastBoostUntil ? stats.minSpeedKmh : stats.minSpeedKmh / 2;
  return Math.round(player.speed + (slowedTarget - player.speed) * depth);
}

function slowedTurnRate(player, stats, now = Date.now()) {
  return stats.turnRateDegPerSec * (1 - mineSlowDepth(player, now) * 0.5);
}

function planeWorldSpeed(player, stats, now = Date.now()) {
  const botScale = player.isBot ? fixed('botSpeedMultiplier') : 1;
  return (getSpeedKmh(player, now) * fixed('worldSpeedScale') / fixed('kmhToMetersPerSecond')) * botScale;
}

function createSpawnPosition() {
  const margin = fixed('spawnEdgeMargin');
  for (let attempt = 0; attempt < fixed('spawnAttempts'); attempt += 1) {
    const position = {
      x: margin + Math.random() * (world.width - margin * 2),
      y: margin + Math.random() * (world.height - margin * 2),
    };
    if ([...players.values()].every((player) => Math.hypot(player.x - position.x, player.y - position.y) >= fixed('spawnClearance'))) return position;
  }
  return { x: margin + Math.random() * (world.width - margin * 2), y: margin + Math.random() * (world.height - margin * 2) };
}

function chooseBotSpawnLevel() {
  const weights = fixed('botSpawnWeights');
  let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0);
  for (let index = 0; index < weights.length; index += 1) {
    roll -= weights[index];
    if (roll < 0) return index + 1;
  }
  return 1;
}

function createPlayer(id, name, isBot = false) {
  const level = isBot ? chooseBotSpawnLevel() : 1;
  const stats = levelStats(level);
  const position = createSpawnPosition();
  return {
    id,
    name: String(name || 'Pilot').slice(0, fixed('nameMaxLength')),
    teamId: null,
    teamDamageEnabled: false,
    score: 0,
    kills: 0,
    x: position.x,
    y: position.y,
    angle: Math.random() * 360,
    speed: stats.minSpeedKmh,
    hp: stats.maxHp,
    level,
    xp: 0,
    respawnExperience: 0,
    input: {},
    rocketAmmo: stats.rocketCapacity,
    mineAmmo: stats.mineCapacity,
    rocketReadyAt: 0,
    mineReadyAt: 0,
    rocketLaunchAt: 0,
    mineArmAt: 0,
    rocketPhase: 'ready',
    minePhase: 'ready',
    rocketReloadAt: 0,
    mineReloadAt: 0,
    respawnAt: 0,
    spawnedAt: Date.now(),
    invulnerableUntil: Date.now() + fixed('spawnInvulnerableMs'),
    isBot,
    nextBotDecisionAt: 0,
    botTargetId: null,
    botTargetExpiresAt: 0,
    botNextTargetAt: 0,
    botFireAt: 0,
    botMineAt: 0,
    botActionQueue: [],
    botDesiredInput: {},
    botAimTargetAngle: null,
    fastBoostUntil: 0,
    fastReadyAt: 0,
    fastOriginalSpeed: null,
    lastAttackedAt: 0,
    mineSlowStartedAt: 0,
    mineSlowUntil: 0,
    mineSlowDurationMs: 0,
  };
}

function respawnPlayer(player) {
  if (player.isBot) {
    player.level = chooseBotSpawnLevel();
    player.xp = 0;
  } else {
    applyTotalExperience(player, player.respawnExperience ?? 0);
  }
  player.respawnExperience = 0;
  const stats = levelStats(player.level);
  const position = createSpawnPosition();
  player.x = position.x;
  player.y = position.y;
  player.angle = Math.random() * 360;
  player.speed = stats.minSpeedKmh;
  player.hp = stats.maxHp;
  player.kills = 0;
  player.input = {};
  player.rocketAmmo = stats.rocketCapacity;
  player.mineAmmo = stats.mineCapacity;
  player.rocketReadyAt = 0;
  player.mineReadyAt = 0;
  player.rocketLaunchAt = 0;
  player.mineArmAt = 0;
  player.rocketPhase = 'ready';
  player.minePhase = 'ready';
  player.rocketReloadAt = 0;
  player.mineReloadAt = 0;
  player.respawnAt = 0;
  player.spawnedAt = Date.now();
  player.invulnerableUntil = player.spawnedAt + fixed('spawnInvulnerableMs');
  player.nextBotDecisionAt = 0;
  player.botTargetId = null;
  player.botTargetExpiresAt = 0;
  player.botNextTargetAt = Date.now();
  player.botFireAt = 0;
  player.botMineAt = 0;
  player.botActionQueue = [];
  player.botDesiredInput = {};
  player.botAimTargetAngle = null;
  player.fastBoostUntil = 0;
  player.fastReadyAt = 0;
  player.fastOriginalSpeed = null;
  player.lastAttackedAt = 0;
  player.mineSlowStartedAt = 0;
  player.mineSlowUntil = 0;
  player.mineSlowDurationMs = 0;
}

function maintainBotPopulation() {
  const targetBotCount = fixed('botCount');
  let bots = [...players.values()].filter((player) => player.isBot);
  while (bots.length > targetBotCount) {
    players.delete(bots.pop().id);
  }
  while (bots.length < targetBotCount) {
    const id = `bot-${nextBotId++}`;
    const bot = createPlayer(id, `Airbot ${String(nextBotId - 1).padStart(2, '0')}`, true);
    players.set(id, bot);
    bots.push(bot);
  }
}

function getPlayerSnapshot(player, now) {
  syncWeaponPhase(player, now);
  const stats = levelStats(player.level);
  const rocketReloadRemaining = Math.max(0, player.rocketReloadAt - now);
  const mineReloadRemaining = Math.max(0, player.mineReloadAt - now);
  return {
    id: player.id,
    name: player.name,
    teamId: getEffectiveTeamId(player),
    score: player.score,
    kills: player.kills,
    x: player.x,
    y: player.y,
    angle: player.angle,
    speed: player.speed,
    speedKmh: getSpeedKmh(player, now),
    hp: player.hp,
    maxHp: stats.maxHp,
    level: player.level,
    isBot: player.isBot,
    outOfMap: player.x < 0 || player.y < 0 || player.x > world.width || player.y > world.height,
    spawnedAt: player.spawnedAt,
    spawnProtectionRemainingMs: Math.max(0, player.invulnerableUntil - now),
    respawnRemainingMs: Math.max(0, player.respawnAt - now),
    attackedAt: player.lastAttackedAt,
    xp: player.xp,
    xpForNextLevel: player.level >= MAX_LEVEL ? 0 : stats.xpToNextLevel,
    cameraScale: stats.cameraScale,
    planeTier: Math.ceil(Math.min(MAX_LEVEL, player.level) / fixed('levelsPerPlaneTier')),
    minSpeedKmh: stats.minSpeedKmh,
    maxSpeedKmh: stats.maxSpeedKmh,
    fastActiveRemainingMs: Math.max(0, player.fastBoostUntil - now),
    fastCooldownRemainingMs: Math.max(0, player.fastReadyAt - now),
    fastCooldownMs: stats.fastCooldownMs,
    fastDurationMs: stats.fastDurationMs,
    rocketAmmo: player.rocketAmmo,
    rocketCapacity: stats.rocketCapacity,
    rocketPhase: player.rocketPhase,
    rocketPhaseRemaining: Math.max(0, player.rocketPhase === 'charging' ? rocketReloadRemaining : player.rocketReadyAt - now),
    rocketPrepareMs: stats.rocketPrepareMs,
    rocketChargeMs: stats.rocketChargeMs,
    rocketRechargeRemainingMs: rocketReloadRemaining,
    rocketChargeProgress: player.rocketAmmo >= stats.rocketCapacity ? 1 : Math.max(0, Math.min(1, 1 - rocketReloadRemaining / stats.rocketChargeMs)),
    rocketDamage: stats.rocketDamage,
    rocketRange: stats.rocketRange,
    mineAmmo: player.mineAmmo,
    mineCapacity: stats.mineCapacity,
    minePhase: player.minePhase,
    minePhaseRemaining: Math.max(0, player.minePhase === 'charging' ? mineReloadRemaining : player.mineReadyAt - now),
    minePrepareMs: stats.minePrepareMs,
    mineChargeMs: stats.mineChargeMs,
    mineRechargeRemainingMs: mineReloadRemaining,
    mineChargeProgress: player.mineAmmo >= stats.mineCapacity ? 1 : Math.max(0, Math.min(1, 1 - mineReloadRemaining / stats.mineChargeMs)),
    mineDamage: stats.mineDamage,
  };
}

function broadcastSnapshot() {
  const now = Date.now();
  const snapshot = JSON.stringify({
    type: 'snapshot',
    players: [...players.values()].map((player) => getPlayerSnapshot(player, now)),
    rockets: rockets.map(({ id, ownerId, ownerIsBot, ownerTeamId, mineLaunched, x, y, angle, active, variant, trackingTargetId }) => ({ id, ownerId, ownerIsBot, ownerTeamId, mineLaunched: Boolean(mineLaunched), x, y, angle, active, variant, trackingTargetId })),
    mines: mines.map(({ id, ownerId, ownerTeamId, x, y, armed, visible, variant }) => ({ id, ownerId, ownerTeamId, x, y, armed, visible, variant })),
    blasts: blasts.map(({ id, x, y, frame }) => ({ id, x, y, frame })),
  });
  for (const client of server.clients) {
    if (client.readyState === 1) client.send(snapshot);
  }
}

function totalExperience(player) {
  let total = player.xp;
  for (let level = 1; level < player.level; level += 1) total += levelStats(level).xpToNextLevel;
  return total;
}

function applyTotalExperience(player, amount) {
  let remaining = Math.max(0, Math.floor(amount));
  player.level = 1;
  while (player.level < MAX_LEVEL && remaining >= levelStats(player.level).xpToNextLevel) {
    remaining -= levelStats(player.level).xpToNextLevel;
    player.level += 1;
  }
  player.xp = remaining;
}

function addExperience(player, amount) {
  if (player.level >= MAX_LEVEL) return;
  player.xp += amount;
  while (player.level < MAX_LEVEL && player.xp >= levelStats(player.level).xpToNextLevel) {
    player.xp -= levelStats(player.level).xpToNextLevel;
    player.level += 1;
    const stats = levelStats(player.level);
    player.hp = Math.min(stats.maxHp, player.hp + stats.levelUpHeal);
    player.rocketAmmo = Math.min(stats.rocketCapacity, player.rocketAmmo + 1);
    player.mineAmmo = Math.min(stats.mineCapacity, player.mineAmmo + 1);
    player.speed = Math.max(stats.minSpeedKmh, Math.min(stats.maxSpeedKmh, player.speed));
  }
}

function damagePlayer(victim, damage, ownerId) {
  if (Date.now() < victim.invulnerableUntil) return;
  const previousHp = victim.hp;
  const victimLevel = victim.level;
  victim.lastAttackedAt = Date.now();
  victim.hp = Math.max(0, victim.hp - damage);
  const attacker = players.get(ownerId);
  if (attacker && attacker.id !== victim.id && attacker.hp > 0) {
    if (victim.hp === 0 && previousHp > 0) {
      const levelDifference = victimLevel - attacker.level;
      attacker.kills += 1;
      attacker.score += Math.max(fixed('minKillScore'), fixed('killScoreBase') + levelDifference * fixed('killScorePerLevelGap'));
      addExperience(attacker, Math.max(fixed('minKillXp'), fixed('killXpBase') + levelDifference * fixed('killXpPerLevelGap')));
    } else if (victim.hp > 0) {
      addExperience(attacker, Math.max(fixed('minHitXp'), Math.floor(damage * fixed('hitXpDamageRatio'))));
    }
  }
  if (victim.hp === 0) {
    victim.respawnExperience = Math.floor(totalExperience(victim) * fixed('respawnXpKeepRatio'));
    victim.level = 1;
    victim.xp = 0;
    victim.respawnAt = Date.now() + fixed('respawnDelayMs');
    victim.input = {};
  }
}

function spawnBlast(x, y, now, scale = 0.8) {
  blasts.push({ id: `blast-${now}-${Math.random().toString(36).slice(2, 8)}`, x, y, startedAt: now, frame: 0, scale });
}

function applyBlastDamage(x, y, radius, baseDamage, ownerId, ownerTeamId, teamDamageEnabled, directHitId = null, healShooter = false, slowDurationMs = 0) {
  for (const player of players.values()) {
    if (player.id === ownerId || player.hp <= 0) continue;
    const distance = Math.hypot(player.x - x, player.y - y);
    if (distance > radius) continue;
    const sameTeam = Boolean(ownerTeamId) && getEffectiveTeamId(player) === ownerTeamId;
    if (sameTeam && !teamDamageEnabled) continue;
    const damage = player.id === directHitId ? baseDamage : baseDamage * Math.max(fixed('blastFalloffMin'), 1 - distance / radius);
    const previousHp = player.hp;
    const victimMaxHp = levelStats(player.level).maxHp;
    damagePlayer(player, sameTeam ? damage * fixed('teamBlastDamageMultiplier') : damage, ownerId);
    const actualDamage = previousHp - player.hp;
    if (slowDurationMs > 0 && actualDamage > 0 && player.hp > 0) applyMineSlow(player, Date.now(), slowDurationMs);
    const shooter = healShooter && actualDamage > 0 ? players.get(ownerId) : null;
    if (shooter && shooter.hp > 0) {
      const killed = previousHp > 0 && player.hp === 0;
      const healing = actualDamage * fixed('hitHealRatio') + (killed ? victimMaxHp * fixed('killHealMaxHpRatio') : 0);
      shooter.hp = Math.min(levelStats(shooter.level).maxHp, shooter.hp + healing);
    }
  }
}

function pointToSegmentDistance(pointX, pointY, startX, startY, endX, endY) {
  const segmentX = endX - startX;
  const segmentY = endY - startY;
  const lengthSquared = segmentX * segmentX + segmentY * segmentY;
  const progress = lengthSquared ? Math.max(0, Math.min(1, ((pointX - startX) * segmentX + (pointY - startY) * segmentY) / lengthSquared)) : 0;
  const closestX = startX + segmentX * progress;
  const closestY = startY + segmentY * progress;
  return { distance: Math.hypot(pointX - closestX, pointY - closestY), x: closestX, y: closestY, progress };
}

function launchMineMissile(mine, target, now) {
  const angle = (Math.atan2(target.x - mine.x, -(target.y - mine.y)) * 180) / Math.PI;
  const maxSpeed = fixed('mineMissileMaxSpeed') * (mine.ownerIsBot ? fixed('botSpeedMultiplier') : 1);
  rockets.push({
    id: `mine-missile-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: mine.ownerId,
    ownerIsBot: mine.ownerIsBot,
    ownerTeamId: mine.ownerTeamId,
    teamDamageEnabled: mine.teamDamageEnabled,
    trackingTargetId: target.id,
    mineLaunched: true,
    launchAngle: angle,
    trackingCone: fixed('mineMissileConeDeg'),
    trackingRange: fixed('mineMissileTrackingRange'),
    turnRate: fixed('mineMissileTurnRate'),
    x: mine.x,
    y: mine.y,
    angle,
    variant: mine.variant,
    range: fixed('mineMissileRange'),
    initialSpeed: Math.min(maxSpeed, mine.initialSpeed),
    maxSpeed,
    distance: 0,
    launchAt: now,
    active: true,
    damage: mine.damage,
    slowDurationMs: mine.slowDurationMs || 0,
    bornAt: now,
    expiresAt: now + fixed('mineMissileLifetimeMs'),
  });
}

function queueBotInput(player, input, now) {
  const desired = {
    left: Boolean(input.left),
    right: Boolean(input.right),
    'speed-up': Boolean(input['speed-up']),
    'speed-down': Boolean(input['speed-down']),
  };
  if (Object.keys(desired).every((key) => desired[key] === Boolean(player.botDesiredInput?.[key]))) return;
  player.botDesiredInput = desired;
  player.botActionQueue = (player.botActionQueue ?? []).filter((action) => action.type !== 'input');
  player.botActionQueue.push({ type: 'input', input: desired, executeAt: now + fixed('botReactionMs') });
}

function queueBotAction(player, type, now) {
  if ((player.botActionQueue ?? []).some((action) => action.type === type)) return;
  player.botActionQueue ??= [];
  player.botActionQueue.push({ type, executeAt: now + fixed('botReactionMs') });
}

function queueBotAim(player, angle, now) {
  if ((player.botActionQueue ?? []).some((action) => action.type === 'aim')) return;
  player.botActionQueue ??= [];
  player.botActionQueue.push({ type: 'aim', angle, executeAt: now + fixed('botReactionMs') });
}

function shortestAngleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function rocketForwardOffset(rocket, plane) {
  const ahead = (Math.atan2(plane.x - rocket.x, -(plane.y - rocket.y)) * 180) / Math.PI;
  return shortestAngleDelta(rocket.angle, ahead);
}

function rocketCanTrack(rocket, plane) {
  if (!plane || plane.hp <= 0 || plane.id === rocket.ownerId) return false;
  const sameTeam = Boolean(rocket.ownerTeamId) && getEffectiveTeamId(plane) === rocket.ownerTeamId;
  if (sameTeam && !rocket.teamDamageEnabled) return false;
  const distance = Math.hypot(plane.x - rocket.x, plane.y - rocket.y);
  if (distance > rocket.trackingRange) return false;
  return Math.abs(rocketForwardOffset(rocket, plane)) <= rocket.trackingCone;
}

function chooseRocketTarget(rocket) {
  const current = rocket.trackingTargetId ? players.get(rocket.trackingTargetId) : null;
  if (rocket.mineLaunched) {
    if (!current || current.hp <= 0 || current.id === rocket.ownerId) return null;
    return current;
  }
  if (rocketCanTrack(rocket, current)) return current;
  let best = null;
  let bestScore = Infinity;
  for (const candidate of players.values()) {
    if (!rocketCanTrack(rocket, candidate)) continue;
    const distance = Math.hypot(candidate.x - rocket.x, candidate.y - rocket.y);
    const angle = Math.abs(rocketForwardOffset(rocket, candidate));
    const score = (angle / Math.max(1, rocket.trackingCone)) + (distance / Math.max(1, rocket.trackingRange));
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function syncWeaponPhase(player, now) {
  player.rocketPhase = player.rocketAmmo < 1 ? 'charging' : (now < player.rocketReadyAt ? 'preparing' : 'ready');
  player.minePhase = player.mineAmmo < 1 ? 'charging' : (now < player.mineReadyAt ? 'preparing' : 'ready');
}

function fireRocket(player, now) {
  const stats = levelStats(player.level);
  if (Date.now() < player.invulnerableUntil) return;
  if (player.rocketAmmo < 1 || now < player.rocketReadyAt) return;
  const launchAt = now;
  player.rocketAmmo -= 1;
  player.rocketLaunchAt = launchAt;
  if (!player.rocketReloadAt) player.rocketReloadAt = launchAt + stats.rocketChargeMs;
  player.rocketReadyAt = launchAt + stats.rocketPrepareMs;
  syncWeaponPhase(player, now);
  const planeSpeed = planeWorldSpeed(player, stats);
  rockets.push({
    id: `rocket-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: player.id,
    ownerIsBot: player.isBot,
    ownerTeamId: getEffectiveTeamId(player),
    teamDamageEnabled: player.teamDamageEnabled,
    trackingTargetId: null,
    launchAngle: player.angle,
    trackingCone: stats.rocketTrackingConeDeg,
    trackingRange: stats.rocketTrackingRange,
    turnRate: stats.rocketTurnRateDegPerSec,
    x: player.x,
    y: player.y,
    angle: player.angle,
    variant: Math.ceil(Math.min(MAX_LEVEL, player.level) / fixed('levelsPerPlaneTier')),
    range: stats.rocketRange,
    initialSpeed: planeSpeed * fixed('rocketLaunchSpeedMultiplier'),
    maxSpeed: fixed('rocketMaxSpeed') * (player.isBot ? fixed('botSpeedMultiplier') : 1),
    distance: 0,
    launchAt,
    active: true,
    damage: stats.rocketDamage * (player.isBot ? fixed('botDamageMultiplier') : 1),
    bornAt: launchAt,
    expiresAt: launchAt + fixed('rocketLifetimeMs'),
  });
}

function activateFast(player, now) {
  if (player.hp <= 0) return;
  if (now < player.fastBoostUntil) {
    player.fastBoostUntil = now;
    return;
  }
  if (now < player.fastReadyAt) return;
  const stats = levelStats(player.level);
  player.fastOriginalSpeed = player.speed;
  player.fastBoostUntil = now + stats.fastDurationMs;
  player.fastReadyAt = now + stats.fastCooldownMs;
}

function dropMine(player, now) {
  const stats = levelStats(player.level);
  if (Date.now() < player.invulnerableUntil) return;
  if (player.mineAmmo < 1 || now < player.mineReadyAt) return;
  const armAt = now;
  player.mineAmmo -= 1;
  player.mineArmAt = armAt;
  if (!player.mineReloadAt) player.mineReloadAt = armAt + stats.mineChargeMs;
  player.mineReadyAt = armAt + stats.minePrepareMs;
  syncWeaponPhase(player, now);
  mines.push({
    id: `mine-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: player.id,
    ownerTeamId: getEffectiveTeamId(player),
    teamDamageEnabled: player.teamDamageEnabled,
    ownerIsBot: player.isBot,
    x: player.x,
    y: player.y,
    variant: Math.ceil(Math.min(MAX_LEVEL, player.level) / fixed('levelsPerPlaneTier')),
    armAt,
    expiresAt: armAt + fixed('mineLifetimeMs'),
    damage: stats.mineDamage * (player.isBot ? fixed('botDamageMultiplier') : 1),
    slowDurationMs: stats.mineSlowMs,
    initialSpeed: planeWorldSpeed(player, stats) * fixed('rocketLaunchSpeedMultiplier'),
    armed: true,
    visible: true,
  });
}

function tick() {
  const now = Date.now();
  const delta = Math.min((now - lastTickAt) / 1000, fixed('maxDeltaSeconds'));
  lastTickAt = now;

  for (let index = blasts.length - 1; index >= 0; index -= 1) {
    const blast = blasts[index];
    blast.frame = Math.min(fixed('blastFrameCount') - 1, Math.floor((now - blast.startedAt) / fixed('blastFrameMs')));
    if (now - blast.startedAt >= fixed('blastDurationMs')) blasts.splice(index, 1);
  }

  for (const player of players.values()) {
    const stats = levelStats(player.level);
    if (player.hp > 0) player.hp = Math.min(stats.maxHp, player.hp + stats.treatmentPerSecond * delta);
    syncWeaponPhase(player, now);
    if (player.respawnAt && player.respawnAt <= now) {
      respawnPlayer(player);
      continue;
    }
    if (player.hp <= 0) continue;

    if (player.isBot) {
      const canTargetPlayer = (candidate) => !(getEffectiveTeamId(player) && getEffectiveTeamId(player) === getEffectiveTeamId(candidate) && !player.teamDamageEnabled);
      const dueActions = [];
      player.botActionQueue = (player.botActionQueue ?? []).filter((action) => {
        if (action.executeAt > now) return true;
        dueActions.push(action);
        return false;
      });
      for (const action of dueActions) {
        if (action.type === 'input') player.input = action.input;
        if (action.type === 'aim') player.botAimTargetAngle = action.angle;
        if (action.type === 'rocket') fireRocket(player, now);
        if (action.type === 'mine') dropMine(player, now);
      }
      let target = player.botTargetId ? players.get(player.botTargetId) : null;
      if (player.botTargetId && (!target || target.id === player.id || target.hp <= 0 || !canTargetPlayer(target) || now >= player.botTargetExpiresAt)) {
        player.botTargetId = null;
        player.botTargetExpiresAt = 0;
        player.botNextTargetAt = now + fixed('botRetargetMs');
        target = null;
      }
      if (!target && now >= player.botNextTargetAt) {
        const nearbyBots = [...players.values()].filter((candidate) => {
          return candidate.isBot && candidate.id !== player.id && candidate.hp > 0 && canTargetPlayer(candidate) && Math.hypot(candidate.x - player.x, candidate.y - player.y) <= fixed('botSightRange');
        });
        const nearbyHumans = [...players.values()].filter((candidate) => {
          return !candidate.isBot && candidate.hp > 0 && canTargetPlayer(candidate) && Math.hypot(candidate.x - player.x, candidate.y - player.y) <= fixed('botSightRange');
        });
        const chooseHuman = nearbyHumans.length > 0 && (nearbyBots.length === 0 || Math.random() < fixed('botPreferHumanChance'));
        const candidates = chooseHuman ? nearbyHumans : nearbyBots.length ? nearbyBots : nearbyHumans;
        if (candidates.length) {
          target = candidates[Math.floor(Math.random() * candidates.length)];
          player.botTargetId = target.id;
          player.botTargetExpiresAt = now + fixed('botLockMs');
        } else {
          player.botNextTargetAt = now + fixed('botRetargetMs');
        }
      }

      if (target) {
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const distance = Math.hypot(dx, dy);
        const targetStats = levelStats(target.level);
        const targetWorldSpeed = planeWorldSpeed(target, targetStats);
        const rocketWorldSpeed = fixed('rocketMaxSpeed') * fixed('botSpeedMultiplier');
        const leadTime = distance / rocketWorldSpeed;
        const targetDirection = (target.angle * Math.PI) / 180;
        const aimX = target.x + Math.sin(targetDirection) * targetWorldSpeed * leadTime;
        const aimY = target.y - Math.cos(targetDirection) * targetWorldSpeed * leadTime;
        const targetAngle = (Math.atan2(aimX - player.x, -(aimY - player.y)) * 180) / Math.PI;
        const turn = ((targetAngle - player.angle + 540) % 360) - 180;
        queueBotAim(player, targetAngle, now);
        queueBotInput(player, { left: false, right: false, 'speed-up': distance > fixed('botSpeedUpDistance'), 'speed-down': distance < fixed('botSpeedDownDistance') }, now);
        if (distance <= stats.rocketRange * fixed('botRocketRangeFraction') && Math.abs(turn) < fixed('botAimToleranceDeg') && now >= player.botFireAt && player.rocketAmmo > 0) {
          queueBotAction(player, 'rocket', now);
          player.botFireAt = now + fixed('botRocketCooldownMs') + Math.random() * fixed('botRocketCooldownRandomMs');
        }
        const facingX = Math.sin((player.angle * Math.PI) / 180);
        const facingY = -Math.cos((player.angle * Math.PI) / 180);
        const targetBehind = (dx * facingX + dy * facingY) < -distance * fixed('botMineBehindFraction');
        const canDamageTarget = !(getEffectiveTeamId(player) && getEffectiveTeamId(player) === getEffectiveTeamId(target) && !player.teamDamageEnabled);
        if (targetBehind && distance <= fixed('botMineDistance') && canDamageTarget && player.mineAmmo > 0 && now >= player.mineReadyAt && now >= (player.botMineAt ?? 0)) {
          queueBotAction(player, 'mine', now);
          player.botMineAt = now + fixed('botMineCooldownMs') + Math.random() * fixed('botMineCooldownRandomMs');
        }
      } else if (now >= player.nextBotDecisionAt) {
        const freeFlightTurn = Math.random();
        const wanderLeft = fixed('botWanderLeftChance');
        queueBotInput(player, {
          left: freeFlightTurn < wanderLeft,
          right: freeFlightTurn >= wanderLeft && freeFlightTurn < wanderLeft + fixed('botWanderRightChance'),
          'speed-up': Math.random() < fixed('botWanderSpeedUpChance'),
          'speed-down': Math.random() < fixed('botWanderSpeedDownChance'),
        }, now);
        player.nextBotDecisionAt = now + fixed('botWanderMinMs') + Math.random() * fixed('botWanderRandomMs');
      }
      if (!target) queueBotAim(player, null, now);
    }

    if (player.isBot && player.botAimTargetAngle !== null) {
      const aimTurn = shortestAngleDelta(player.angle, player.botAimTargetAngle);
      const aimStep = slowedTurnRate(player, stats, now) * delta;
      player.angle += Math.max(-aimStep, Math.min(aimStep, aimTurn));
    }
    const yawInput = Number.isFinite(player.input.yaw) ? Math.max(-1, Math.min(1, player.input.yaw)) : Number(Boolean(player.input.right)) - Number(Boolean(player.input.left));
    player.angle += slowedTurnRate(player, stats, now) * yawInput * delta;
    player.angle = ((player.angle % 360) + 360) % 360;
    const speedChange = stats.speedAccelerationKmhPerSec * delta;
    if (now < player.fastBoostUntil) {
      player.speed = Math.min(stats.maxSpeedKmh * fixed('fastTopSpeedMultiplier'), player.speed + fixed('fastBoostKmhPerSec') * delta);
    }
    else if (player.fastOriginalSpeed !== null) {
      const recoveryStep = fixed('fastRecoveryKmhPerSec') * delta;
      const recoveryDistance = player.speed - player.fastOriginalSpeed;
      if (Math.abs(recoveryDistance) <= recoveryStep) {
        player.speed = player.fastOriginalSpeed;
        player.fastOriginalSpeed = null;
      } else {
        player.speed -= Math.sign(recoveryDistance) * recoveryStep;
      }
    } else if (player.speed > stats.maxSpeedKmh) player.speed = Math.max(stats.maxSpeedKmh, player.speed - speedChange * fixed('overspeedBrakeMultiplier'));
    else {
      const throttleInput = Number.isFinite(player.input.throttle) ? Math.max(-1, Math.min(1, player.input.throttle)) : Number(Boolean(player.input['speed-up'])) - Number(Boolean(player.input['speed-down']));
      if (throttleInput > 0) player.speed = Math.min(stats.maxSpeedKmh, player.speed + speedChange * throttleInput);
      if (throttleInput < 0) player.speed = Math.max(stats.minSpeedKmh, player.speed + speedChange * throttleInput);
    }
    const angle = (player.angle * Math.PI) / 180;
    // Map coordinates are pixels, so aircraft cover more than one pixel per
    // real-world meter to keep the displayed airspeed responsive in the world.
    const worldSpeed = planeWorldSpeed(player, stats, now);
    player.x += Math.sin(angle) * worldSpeed * delta;
    player.y -= Math.cos(angle) * worldSpeed * delta;

    const outsidePlayground = player.x < 0 || player.y < 0 || player.x > world.width || player.y > world.height;
    if (outsidePlayground) {
      damagePlayer(player, stats.maxHp * stats.outOfMapHpFractionPerSecond * delta, null);
      if (player.hp <= 0) continue;
    }

    if (player.rocketReloadAt && player.rocketReloadAt <= now) {
      if (player.rocketAmmo < stats.rocketCapacity) {
        player.rocketAmmo += 1;
        player.rocketReloadAt = player.rocketAmmo < stats.rocketCapacity ? now + stats.rocketChargeMs : 0;
      } else player.rocketReloadAt = 0;
    }
    if (player.mineReloadAt && player.mineReloadAt <= now) {
      if (player.mineAmmo < stats.mineCapacity) {
        player.mineAmmo += 1;
        player.mineReloadAt = player.mineAmmo < stats.mineCapacity ? now + stats.mineChargeMs : 0;
      } else player.mineReloadAt = 0;
    }
  }

  const rocketSegments = new Map();
  for (let index = rockets.length - 1; index >= 0; index -= 1) {
    const rocket = rockets[index];
    if (!rocket.active && now >= rocket.launchAt) {
      const owner = players.get(rocket.ownerId);
      if (owner) {
        const angle = (owner.angle * Math.PI) / 180;
        rocket.x = owner.x + Math.sin(angle) * fixed('rocketMuzzleOffset');
        rocket.y = owner.y - Math.cos(angle) * fixed('rocketMuzzleOffset');
        rocket.angle = owner.angle;
      }
      rocket.active = true;
    }
    if (!rocket.active) continue;
    const target = chooseRocketTarget(rocket);
    rocket.trackingTargetId = target ? target.id : null;
    if (target) {
      const turn = rocketForwardOffset(rocket, target);
      rocket.angle += Math.max(-rocket.turnRate * delta, Math.min(rocket.turnRate * delta, turn));
    }
    const previousX = rocket.x;
    const previousY = rocket.y;
    const angle = (rocket.angle * Math.PI) / 180;
    const accelerationProgress = Math.max(0, Math.min(1, (now - rocket.launchAt) / fixed('rocketRampMs')));
    const maxSpeed = rocket.maxSpeed ?? (rocket.mineLaunched ? fixed('mineMissileMaxSpeed') : fixed('rocketMaxSpeed'));
    const initialSpeed = rocket.initialSpeed ?? 0;
    const travel = (initialSpeed + (maxSpeed - initialSpeed) * accelerationProgress) * delta;
    rocket.distance += travel;
    rocket.x += Math.sin(angle) * travel;
    rocket.y -= Math.cos(angle) * travel;
    rocketSegments.set(rocket.id, { startX: previousX, startY: previousY, endX: rocket.x, endY: rocket.y });
    let hit = false;
    let impact = null;
    for (const player of players.values()) {
      if (player.id === rocket.ownerId || player.hp <= 0) continue;
      const collisionRadius = (player.isBot ? fixed('botHitRadius') : fixed('playerHitRadius')) + fixed('hitRadiusPadding');
      const contact = pointToSegmentDistance(player.x, player.y, previousX, previousY, rocket.x, rocket.y);
      if (contact.distance <= collisionRadius && (!impact || contact.distance < impact.distance)) impact = { ...contact, playerId: player.id };
    }
    if (impact) {
      const blastRadius = rocket.mineLaunched ? fixed('mineMissileBlastRadius') : fixed('rocketBlastRadius');
      applyBlastDamage(impact.x, impact.y, blastRadius, rocket.damage, rocket.ownerId, rocket.ownerTeamId, rocket.teamDamageEnabled, impact.playerId, true, rocket.mineLaunched ? (rocket.slowDurationMs || 0) : 0);
      spawnBlast(impact.x, impact.y, now, rocket.mineLaunched ? fixed('mineMissileBlastScale') : fixed('rocketBlastScale'));
      hit = true;
    }
    if (hit || rocket.distance >= rocket.range || now > rocket.expiresAt) rockets.splice(index, 1);
  }

  const destroyedRocketIds = new Set();
  for (let first = 0; first < rockets.length; first += 1) {
    const firstRocket = rockets[first];
    const firstPath = rocketSegments.get(firstRocket.id);
    if (!firstPath || destroyedRocketIds.has(firstRocket.id)) continue;
    for (let second = first + 1; second < rockets.length; second += 1) {
      const secondRocket = rockets[second];
      const secondPath = rocketSegments.get(secondRocket.id);
      if (!secondPath || destroyedRocketIds.has(secondRocket.id)) continue;
      const sameOwner = firstRocket.ownerId === secondRocket.ownerId;
      const sameTeam = Boolean(firstRocket.ownerTeamId) && firstRocket.ownerTeamId === secondRocket.ownerTeamId;
      if (sameOwner || sameTeam) continue;
      const relativeContact = pointToSegmentDistance(0, 0,
        firstPath.startX - secondPath.startX, firstPath.startY - secondPath.startY,
        firstPath.endX - secondPath.endX, firstPath.endY - secondPath.endY);
      if (relativeContact.distance <= fixed('rocketClashDistance')) {
        const firstX = firstPath.startX + (firstPath.endX - firstPath.startX) * relativeContact.progress;
        const firstY = firstPath.startY + (firstPath.endY - firstPath.startY) * relativeContact.progress;
        const secondX = secondPath.startX + (secondPath.endX - secondPath.startX) * relativeContact.progress;
        const secondY = secondPath.startY + (secondPath.endY - secondPath.startY) * relativeContact.progress;
        destroyedRocketIds.add(firstRocket.id);
        destroyedRocketIds.add(secondRocket.id);
        spawnBlast((firstX + secondX) / 2, (firstY + secondY) / 2, now, fixed('rocketClashBlastScale'));
      }
    }
  }
  if (destroyedRocketIds.size) {
    for (let index = rockets.length - 1; index >= 0; index -= 1) {
      if (destroyedRocketIds.has(rockets[index].id)) rockets.splice(index, 1);
    }
  }

  for (let index = mines.length - 1; index >= 0; index -= 1) {
    const mine = mines[index];
    if (!mine.armed && now >= mine.armAt) {
      mine.armed = true;
      mine.visible = true;
    }
    if (mine.armed) {
      const target = [...players.values()]
        .filter((player) => player.id !== mine.ownerId && player.hp > 0)
        .map((player) => ({ player, distance: Math.hypot(player.x - mine.x, player.y - mine.y) }))
        .filter(({ player, distance }) => {
          const sameTeam = Boolean(mine.ownerTeamId) && getEffectiveTeamId(player) === mine.ownerTeamId;
          return distance <= (player.isBot ? fixed('botMineTriggerRadius') : fixed('playerMineTriggerRadius')) * fixed('mineTriggerScale') && (!sameTeam || mine.teamDamageEnabled);
        })
        .sort((a, b) => a.distance - b.distance)[0]?.player;
      if (target) {
        launchMineMissile(mine, target, now);
        mines.splice(index, 1);
        continue;
      }
    }
    if (now >= mine.expiresAt) {
      applyBlastDamage(mine.x, mine.y, fixed('mineExpireRadius'), mine.damage * fixed('mineExpireDamageRatio'), mine.ownerId, mine.ownerTeamId, mine.teamDamageEnabled, null, false, mine.slowDurationMs || 0);
      spawnBlast(mine.x, mine.y, now, fixed('mineExpireBlastScale'));
      mines.splice(index, 1);
    }
  }

  if (now - lastBroadcastAt >= fixed('broadcastMs')) {
    lastBroadcastAt = now;
    broadcastSnapshot();
  }
}

setInterval(tick, fixed('tickMs'));

if (!process.env.VERCEL) {
  httpServer.listen(port, '0.0.0.0', () => {
    const mode = process.env.NODE_ENV === 'production' ? `client at http://localhost:${port}` : 'websocket only';
    console.log(`Game server listening on port ${port} (${mode})`);
  });
}

const visitorsFile = join(dirname(fileURLToPath(import.meta.url)), '../data/visitors.json');
const onlineVisitors = new Map();

function localDay() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function loadTodayVisitors() {
  const day = localDay();
  try {
    const saved = JSON.parse(readFileSync(visitorsFile, 'utf8'));
    if (saved.day === day && Array.isArray(saved.ids)) return { day, ids: new Set(saved.ids.filter((id) => typeof id === 'string')) };
  } catch {
    // A missing file means the day has not started yet.
  }
  return { day, ids: new Set() };
}

let todayVisitors = loadTodayVisitors();

function rememberToday() {
  if (todayVisitors.day === localDay()) return;
  todayVisitors = { day: localDay(), ids: new Set(onlineVisitors.keys()) };
  saveTodayVisitors();
}

function saveTodayVisitors() {
  try {
    mkdirSync(dirname(visitorsFile), { recursive: true });
    writeFileSync(visitorsFile, JSON.stringify({ day: todayVisitors.day, ids: [...todayVisitors.ids] }));
  } catch {
    // The count still updates in memory when the disk cannot be written.
  }
}

function broadcastVisitors() {
  rememberToday();
  const payload = JSON.stringify({ type: 'visitors', today: todayVisitors.ids.size, current: onlineVisitors.size });
  for (const client of server.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function noteVisit(socket, rawId) {
  const id = String(rawId || '').trim().slice(0, 80);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) return;
  if (socket.visitorId === id) {
    broadcastVisitors();
    return;
  }
  if (socket.visitorId) releaseVisit(socket);
  socket.visitorId = id;
  rememberToday();
  const alreadyToday = todayVisitors.ids.has(id);
  todayVisitors.ids.add(id);
  if (!alreadyToday) saveTodayVisitors();
  onlineVisitors.set(id, (onlineVisitors.get(id) || 0) + 1);
  broadcastVisitors();
}

function releaseVisit(socket) {
  const id = socket.visitorId;
  if (!id) return;
  socket.visitorId = null;
  const remaining = (onlineVisitors.get(id) || 1) - 1;
  if (remaining <= 0) onlineVisitors.delete(id);
  else onlineVisitors.set(id, remaining);
  broadcastVisitors();
}

server.on('connection', (socket) => {
  console.log('Client connected');
  socket.send(JSON.stringify({ type: 'welcome', message: 'Connected to the game server!' }));
  socket.send(JSON.stringify({ type: 'world', world }));
  broadcastVisitors();

  socket.on('message', (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());
      if (message.type === 'visit') {
        noteVisit(socket, message.id);
        return;
      }
      if (message.type === 'join' && typeof message.id === 'string') {
        if (socket.playerId && socket.playerId !== message.id) players.delete(socket.playerId);
        socket.playerId = message.id;
        if (!players.has(socket.playerId)) players.set(socket.playerId, createPlayer(socket.playerId, message.name));
        const joinedPlayer = players.get(socket.playerId);
        joinedPlayer.name = String(message.name || 'Pilot').slice(0, fixed('nameMaxLength'));
        const teamCode = typeof message.teamCode === 'string' ? message.teamCode.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, fixed('nameMaxLength')) : '';
        joinedPlayer.teamId = teamCode ? `team:${teamCode}` : null;
        joinedPlayer.teamDamageEnabled = Boolean(message.teamDamageEnabled);
        maintainBotPopulation();
        broadcastSnapshot();
        return;
      }
      if (message.type === 'leave') {
        if (socket.playerId) players.delete(socket.playerId);
        socket.playerId = null;
        maintainBotPopulation();
        broadcastSnapshot();
        return;
      }
      const player = socket.playerId ? players.get(socket.playerId) : null;
      if (!player) return;
      if (message.type === 'input' && message.input && typeof message.input === 'object') {
        player.input = {
          left: Boolean(message.input.left),
          right: Boolean(message.input.right),
          'speed-up': Boolean(message.input['speed-up']),
          'speed-down': Boolean(message.input['speed-down']),
          yaw: Number.isFinite(message.input.yaw) ? Math.max(-1, Math.min(1, message.input.yaw)) : null,
          throttle: Number.isFinite(message.input.throttle) ? Math.max(-1, Math.min(1, message.input.throttle)) : null,
          fast: Boolean(message.input.fast),
        };
      }
      if (message.type === 'launch-rocket') fireRocket(player, Date.now());
      if (message.type === 'drop-mine') dropMine(player, Date.now());
      if (message.type === 'activate-fast') activateFast(player, Date.now());
    } catch {
      // Ignore malformed input; the server owns all gameplay state.
    }
  });

  socket.on('close', () => {
    releaseVisit(socket);
    if (socket.playerId) {
      players.delete(socket.playerId);
      maintainBotPopulation();
    }
    broadcastSnapshot();
    console.log('Client disconnected');
  });
  socket.on('error', (error) => console.error('WebSocket error:', error.message));
});

httpServer.on('error', (error) => console.error('Server error:', error.message));

export default httpServer;
