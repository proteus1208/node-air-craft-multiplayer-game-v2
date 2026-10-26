import { WebSocketServer } from 'ws';

const port = Number(process.env.PORT ?? 3001);
const server = new WebSocketServer({ port });
const MAX_LEVEL = 15;

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
  const width = 4000;
  const height = 4000;
  let seed = 48271;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const clouds = Array.from({ length: 9 }, (_, index) => ({
    id: `cloud-${index}`,
    type: 'cloud',
    x: 160 + random() * (width - 320),
    y: 140 + random() * (height - 280),
    size: 190 + random() * 90,
    variant: Math.floor(random() * 5) + 1,
  }));
  // Place land features with a shared clearance radius so flowers, trees,
  // rocks, and lakes don't overlap or hide each other.
  const objects = [];
  const placeObjects = (type, count, sizeMin, sizeMax, clearance) => {
    for (let index = 0; index < count; index += 1) {
      let point = null;
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const candidate = {
          x: 140 + random() * (width - 280),
          y: 140 + random() * (height - 280),
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
        variant: Math.floor(random() * 5) + 1,
      });
    }
  };
  placeObjects('tree', 100, 76, 114, 155);
  placeObjects('flower', 168, 34, 58, 100);
  placeObjects('rock', 42, 54, 92, 145);
  placeObjects('pool', 16, 120, 210, 240);

  return { width, height, clouds, objects };
}

function levelStats(level) {
  const progress = Math.max(0, level - 1);
  const minSpeed = Math.round(35 - (progress * 15) / (MAX_LEVEL - 1));
  const maxSpeed = Math.round(40 + (progress * 20) / (MAX_LEVEL - 1));
  const minSpeedKmh = Math.round(150 + progress * 12.5);
  const speedRangeKmh = Math.round(56 + progress * 14);
  return {
    minSpeed,
    maxSpeed,
    // L1 range is 70% of its previous 80 km/h spread; L5 is exactly 2x L1.
    minSpeedKmh,
    maxSpeedKmh: minSpeedKmh + speedRangeKmh,
    speedAccelerationKmhPerSec: 36,
    rocketCapacity: 3 + Math.floor(level / 2),
    mineCapacity: 2 + Math.floor(level / 3),
    maxHp: 100 + progress * 10,
    treatmentPerSecond: 1 + (progress * 2) / (MAX_LEVEL - 1),
    rocketPrepareMs: 1000 - progress * 50,
    rocketChargeMs: Math.round(2300 - (progress * 1100) / (MAX_LEVEL - 1)),
    minePrepareMs: 2000 - progress * 100,
    mineChargeMs: Math.round(5000 - (progress * 1800) / (MAX_LEVEL - 1)),
    fastDurationMs: Math.round(3000 + (progress * 2000) / (MAX_LEVEL - 1)),
    fastCooldownMs: Math.round(10000 - (progress * 5000) / (MAX_LEVEL - 1)),
    rocketDamage: Math.round(20 + (progress * 40) / (MAX_LEVEL - 1)),
    rocketRange: 900 + progress * 250,
    mineDamage: Math.round(35 + (progress * 115) / (MAX_LEVEL - 1)),
  };
}

function getEffectiveTeamId(player) {
  return player.level >= MAX_LEVEL ? 'team:level-15' : player.teamId;
}

function getSpeedKmh(player, stats) {
  const range = Math.max(1, stats.maxSpeed - stats.minSpeed);
  const progress = (player.speed - stats.minSpeed) / range;
  return Math.round(stats.minSpeedKmh + progress * (stats.maxSpeedKmh - stats.minSpeedKmh));
}

function speedUnitsForKmh(speedKmh, stats) {
  const displayedRange = Math.max(1, stats.maxSpeedKmh - stats.minSpeedKmh);
  return stats.minSpeed + ((speedKmh - stats.minSpeedKmh) / displayedRange) * (stats.maxSpeed - stats.minSpeed);
}

function createSpawnPosition() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const position = {
      x: 140 + Math.random() * (world.width - 280),
      y: 140 + Math.random() * (world.height - 280),
    };
    if ([...players.values()].every((player) => Math.hypot(player.x - position.x, player.y - position.y) >= 260)) return position;
  }
  return { x: 140 + Math.random() * (world.width - 280), y: 140 + Math.random() * (world.height - 280) };
}

function chooseBotSpawnLevel() {
  const weights = [40, 30, 20, 10];
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
    name: String(name || 'Pilot').slice(0, 24),
    teamId: null,
    teamDamageEnabled: false,
    score: 0,
    kills: 0,
    x: position.x,
    y: position.y,
    angle: Math.random() * 360,
    speed: stats.minSpeed,
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
    invulnerableUntil: Date.now() + 3000,
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
  player.speed = stats.minSpeed;
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
  player.invulnerableUntil = player.spawnedAt + 3000;
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
}

function maintainBotPopulation() {
  const targetBotCount = 10;
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
    speedKmh: getSpeedKmh(player, stats),
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
    xpForNextLevel: player.level >= MAX_LEVEL ? 0 : Math.max(1, player.level) * 100,
    minSpeed: stats.minSpeed,
    maxSpeed: stats.maxSpeed,
    minSpeedKmh: stats.minSpeedKmh,
    maxSpeedKmh: stats.maxSpeedKmh,
    fastActiveRemainingMs: Math.max(0, player.fastBoostUntil - now),
    fastCooldownRemainingMs: Math.max(0, player.fastReadyAt - now),
    fastCooldownMs: stats.fastCooldownMs,
    fastDurationMs: stats.fastDurationMs,
    rocketAmmo: player.rocketAmmo,
    rocketCapacity: stats.rocketCapacity,
    rocketPhase: player.rocketPhase,
    rocketPhaseRemaining: Math.max(0, (player.rocketPhase === 'preparing' ? player.rocketLaunchAt : player.rocketReadyAt) - now),
    rocketPrepareMs: stats.rocketPrepareMs,
    rocketChargeMs: stats.rocketChargeMs,
    rocketRechargeRemainingMs: rocketReloadRemaining,
    rocketChargeProgress: player.rocketAmmo >= stats.rocketCapacity ? 1 : Math.max(0, Math.min(1, 1 - rocketReloadRemaining / stats.rocketChargeMs)),
    rocketDamage: stats.rocketDamage,
    rocketRange: stats.rocketRange,
    mineAmmo: player.mineAmmo,
    mineCapacity: stats.mineCapacity,
    minePhase: player.minePhase,
    minePhaseRemaining: Math.max(0, (player.minePhase === 'preparing' ? player.mineArmAt : player.mineReadyAt) - now),
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
  return (50 * (player.level - 1) * player.level) + player.xp;
}

function applyTotalExperience(player, amount) {
  let remaining = Math.max(0, Math.floor(amount));
  player.level = 1;
  while (player.level < MAX_LEVEL && remaining >= player.level * 100) {
    remaining -= player.level * 100;
    player.level += 1;
  }
  player.xp = remaining;
}

function addExperience(player, amount) {
  if (player.level >= MAX_LEVEL) return;
  player.xp += amount;
  while (player.level < MAX_LEVEL && player.xp >= Math.max(1, player.level) * 100) {
    player.xp -= Math.max(1, player.level) * 100;
    player.level += 1;
    const stats = levelStats(player.level);
    player.hp = Math.min(stats.maxHp, player.hp + 20);
    player.rocketAmmo = Math.min(stats.rocketCapacity, player.rocketAmmo + 1);
    player.mineAmmo = Math.min(stats.mineCapacity, player.mineAmmo + 1);
    player.speed = Math.max(stats.minSpeed, Math.min(stats.maxSpeed, player.speed));
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
      attacker.score += Math.max(10, 100 + levelDifference * 15);
      addExperience(attacker, Math.max(10, 34 + levelDifference * 8));
    } else if (victim.hp > 0) {
      addExperience(attacker, Math.max(1, Math.floor(damage * 0.05)));
    }
  }
  if (victim.hp === 0) {
    victim.respawnExperience = Math.floor(totalExperience(victim) * 0.3);
    victim.level = 1;
    victim.xp = 0;
    victim.respawnAt = Date.now() + 5000;
    victim.input = {};
  }
}

function spawnBlast(x, y, now, scale = 0.8) {
  blasts.push({ id: `blast-${now}-${Math.random().toString(36).slice(2, 8)}`, x, y, startedAt: now, frame: 0, scale });
}

function applyBlastDamage(x, y, radius, baseDamage, ownerId, ownerTeamId, teamDamageEnabled, directHitId = null, healShooter = false) {
  for (const player of players.values()) {
    if (player.id === ownerId || player.hp <= 0) continue;
    const distance = Math.hypot(player.x - x, player.y - y);
    if (distance > radius) continue;
    const sameTeam = Boolean(ownerTeamId) && getEffectiveTeamId(player) === ownerTeamId;
    if (sameTeam && !teamDamageEnabled) continue;
    const damage = player.id === directHitId ? baseDamage : baseDamage * Math.max(0.12, 1 - distance / radius);
    const previousHp = player.hp;
    const victimMaxHp = levelStats(player.level).maxHp;
    damagePlayer(player, sameTeam ? damage * 0.5 : damage, ownerId);
    const actualDamage = previousHp - player.hp;
    const shooter = healShooter && actualDamage > 0 ? players.get(ownerId) : null;
    if (shooter && shooter.hp > 0) {
      const killed = previousHp > 0 && player.hp === 0;
      const healing = actualDamage * 0.1 + (killed ? victimMaxHp * 0.1 : 0);
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
  const maxSpeed = 310 * (mine.ownerIsBot ? 0.7 : 1);
  rockets.push({
    id: `mine-missile-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: mine.ownerId,
    ownerIsBot: mine.ownerIsBot,
    ownerTeamId: mine.ownerTeamId,
    teamDamageEnabled: mine.teamDamageEnabled,
    trackingTargetId: target.id,
    mineLaunched: true,
    launchAngle: angle,
    trackingCone: 180,
    trackingRange: 1000,
    turnRate: 150,
    x: mine.x,
    y: mine.y,
    angle,
    variant: mine.variant,
    range: 1000,
    initialSpeed: Math.min(maxSpeed, mine.initialSpeed),
    maxSpeed,
    distance: 0,
    launchAt: now,
    active: true,
    damage: mine.damage,
    bornAt: now,
    expiresAt: now + 4000,
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
  player.botActionQueue.push({ type: 'input', input: desired, executeAt: now + 300 });
}

function queueBotAction(player, type, now) {
  if ((player.botActionQueue ?? []).some((action) => action.type === type)) return;
  player.botActionQueue ??= [];
  player.botActionQueue.push({ type, executeAt: now + 300 });
}

function queueBotAim(player, angle, now) {
  if ((player.botActionQueue ?? []).some((action) => action.type === 'aim')) return;
  player.botActionQueue ??= [];
  player.botActionQueue.push({ type: 'aim', angle, executeAt: now + 300 });
}

function shortestAngleDelta(from, to) {
  return ((to - from + 540) % 360) - 180;
}

function fireRocket(player, now) {
  const stats = levelStats(player.level);
  if (Date.now() < player.invulnerableUntil) return;
  if (player.rocketAmmo < 1 || now < player.rocketReadyAt) return;
  const launchAt = now;
  player.rocketAmmo -= 1;
  player.rocketLaunchAt = launchAt;
  if (!player.rocketReloadAt) player.rocketReloadAt = launchAt + stats.rocketChargeMs;
  player.rocketReadyAt = player.rocketAmmo > 0 ? launchAt : player.rocketReloadAt;
  player.rocketPhase = player.rocketAmmo > 0 ? 'ready' : 'charging';
  const levelProgress = Math.max(0, Math.min(1, (player.level - 1) / (MAX_LEVEL - 1)));
  const planeSpeed = (getSpeedKmh(player, stats) * 2.5 / 3.6) * (player.isBot ? 0.7 : 1);
  const trackingCone = 15 + levelProgress * 30;
  const trackingRange = 68 * (6 + levelProgress * 6);
  rockets.push({
    id: `rocket-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: player.id,
    ownerIsBot: player.isBot,
    ownerTeamId: getEffectiveTeamId(player),
    teamDamageEnabled: player.teamDamageEnabled,
    trackingTargetId: null,
    launchAngle: player.angle,
    trackingCone,
    trackingRange,
    turnRate: 5 + levelProgress * 10,
    x: player.x,
    y: player.y,
    angle: player.angle,
    variant: Math.ceil(Math.min(MAX_LEVEL, player.level) / 3),
    range: stats.rocketRange,
    initialSpeed: planeSpeed * 1.3,
    maxSpeed: 620 * (player.isBot ? 0.7 : 1),
    distance: 0,
    launchAt,
    active: true,
    damage: stats.rocketDamage * (player.isBot ? 0.3 : 1),
    bornAt: launchAt,
    expiresAt: launchAt + 8000,
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
  player.mineReadyAt = player.mineAmmo > 0 ? armAt : player.mineReloadAt;
  player.minePhase = player.mineAmmo > 0 ? 'ready' : 'charging';
  mines.push({
    id: `mine-${now}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: player.id,
    ownerTeamId: getEffectiveTeamId(player),
    teamDamageEnabled: player.teamDamageEnabled,
    ownerIsBot: player.isBot,
    x: player.x,
    y: player.y,
    variant: Math.ceil(Math.min(MAX_LEVEL, player.level) / 3),
    armAt,
    expiresAt: armAt + 20000,
    damage: stats.mineDamage * (player.isBot ? 0.3 : 1),
    initialSpeed: (getSpeedKmh(player, stats) * 2.5 / 3.6) * (player.isBot ? 0.7 : 1) * 1.3,
    armed: true,
    visible: true,
  });
}

function tick() {
  const now = Date.now();
  const delta = Math.min((now - lastTickAt) / 1000, 0.1);
  lastTickAt = now;

  for (let index = blasts.length - 1; index >= 0; index -= 1) {
    const blast = blasts[index];
    blast.frame = Math.min(11, Math.floor((now - blast.startedAt) / 55));
    if (now - blast.startedAt >= 660) blasts.splice(index, 1);
  }

  for (const player of players.values()) {
    const stats = levelStats(player.level);
    if (player.hp > 0) player.hp = Math.min(stats.maxHp, player.hp + stats.treatmentPerSecond * delta);
    if (player.rocketPhase === 'preparing' && now >= player.rocketLaunchAt) player.rocketPhase = 'charging';
    if (player.rocketPhase === 'charging' && now >= player.rocketReadyAt) player.rocketPhase = 'ready';
    if (player.minePhase === 'preparing' && now >= player.mineArmAt) player.minePhase = 'charging';
    if (player.minePhase === 'charging' && now >= player.mineReadyAt) player.minePhase = 'ready';
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
        player.botNextTargetAt = now + 4000;
        target = null;
      }
      if (!target && now >= player.botNextTargetAt) {
        const nearbyBots = [...players.values()].filter((candidate) => {
          return candidate.isBot && candidate.id !== player.id && candidate.hp > 0 && canTargetPlayer(candidate) && Math.hypot(candidate.x - player.x, candidate.y - player.y) <= 1800;
        });
        const nearbyHumans = [...players.values()].filter((candidate) => {
          return !candidate.isBot && candidate.hp > 0 && canTargetPlayer(candidate) && Math.hypot(candidate.x - player.x, candidate.y - player.y) <= 1800;
        });
        const chooseHuman = nearbyHumans.length > 0 && (nearbyBots.length === 0 || Math.random() < 0.5);
        const candidates = chooseHuman ? nearbyHumans : nearbyBots.length ? nearbyBots : nearbyHumans;
        if (candidates.length) {
          target = candidates[Math.floor(Math.random() * candidates.length)];
          player.botTargetId = target.id;
          player.botTargetExpiresAt = now + 10000;
        } else {
          player.botNextTargetAt = now + 4000;
        }
      }

      if (target) {
        const dx = target.x - player.x;
        const dy = target.y - player.y;
        const distance = Math.hypot(dx, dy);
        const targetStats = levelStats(target.level);
        const targetWorldSpeed = (getSpeedKmh(target, targetStats) * 2.5 / 3.6) * (target.isBot ? 0.7 : 1);
        const rocketWorldSpeed = 620 * 0.7;
        const leadTime = distance / rocketWorldSpeed;
        const targetDirection = (target.angle * Math.PI) / 180;
        const aimX = target.x + Math.sin(targetDirection) * targetWorldSpeed * leadTime;
        const aimY = target.y - Math.cos(targetDirection) * targetWorldSpeed * leadTime;
        const targetAngle = (Math.atan2(aimX - player.x, -(aimY - player.y)) * 180) / Math.PI;
        const turn = ((targetAngle - player.angle + 540) % 360) - 180;
        queueBotAim(player, targetAngle, now);
        queueBotInput(player, { left: false, right: false, 'speed-up': distance > 280, 'speed-down': distance < 150 }, now);
        if (distance <= stats.rocketRange * 0.95 && Math.abs(turn) < 10 && now >= player.botFireAt && player.rocketAmmo > 0) {
          queueBotAction(player, 'rocket', now);
          player.botFireAt = now + 2400 + Math.random() * 1600;
        }
        const facingX = Math.sin((player.angle * Math.PI) / 180);
        const facingY = -Math.cos((player.angle * Math.PI) / 180);
        const targetBehind = (dx * facingX + dy * facingY) < -distance * 0.25;
        const canDamageTarget = !(getEffectiveTeamId(player) && getEffectiveTeamId(player) === getEffectiveTeamId(target) && !player.teamDamageEnabled);
        if (targetBehind && distance <= 150 && canDamageTarget && player.mineAmmo > 0 && now >= player.mineReadyAt && now >= (player.botMineAt ?? 0)) {
          queueBotAction(player, 'mine', now);
          player.botMineAt = now + 1800 + Math.random() * 900;
        }
      } else if (now >= player.nextBotDecisionAt) {
        const freeFlightTurn = Math.random();
        queueBotInput(player, {
          left: freeFlightTurn < 0.22,
          right: freeFlightTurn >= 0.22 && freeFlightTurn < 0.44,
          'speed-up': Math.random() < 0.3,
          'speed-down': Math.random() < 0.18,
        }, now);
        player.nextBotDecisionAt = now + 650 + Math.random() * 1350;
      }
      if (!target) queueBotAim(player, null, now);
    }

    if (player.isBot && player.botAimTargetAngle !== null) {
      const aimTurn = shortestAngleDelta(player.angle, player.botAimTargetAngle);
      const aimStep = 115 * delta;
      player.angle += Math.max(-aimStep, Math.min(aimStep, aimTurn));
    }
    const yawInput = Number.isFinite(player.input.yaw) ? Math.max(-1, Math.min(1, player.input.yaw)) : Number(Boolean(player.input.right)) - Number(Boolean(player.input.left));
    player.angle += 115 * yawInput * delta;
    player.angle = ((player.angle % 360) + 360) % 360;
    const speedRange = stats.maxSpeed - stats.minSpeed;
    const displayedSpeedRange = Math.max(1, stats.maxSpeedKmh - stats.minSpeedKmh);
    const speedChange = speedRange * (stats.speedAccelerationKmhPerSec / displayedSpeedRange) * delta;
    if (now < player.fastBoostUntil) {
      const boostedSpeedKmh = Math.min(stats.maxSpeedKmh * 2, getSpeedKmh(player, stats) + 150 * delta);
      player.speed = speedUnitsForKmh(boostedSpeedKmh, stats);
    }
    else if (player.fastOriginalSpeed !== null) {
      const currentSpeedKmh = getSpeedKmh(player, stats);
      const originSpeedKmh = getSpeedKmh({ ...player, speed: player.fastOriginalSpeed }, stats);
      const recoveryStep = 250 * delta;
      const recoveryDistance = currentSpeedKmh - originSpeedKmh;
      if (Math.abs(recoveryDistance) <= recoveryStep) {
        player.speed = player.fastOriginalSpeed;
        player.fastOriginalSpeed = null;
      } else {
        player.speed = speedUnitsForKmh(currentSpeedKmh - Math.sign(recoveryDistance) * recoveryStep, stats);
      }
    } else if (player.speed > stats.maxSpeed) player.speed = Math.max(stats.maxSpeed, player.speed - speedChange * 3);
    else {
      const throttleInput = Number.isFinite(player.input.throttle) ? Math.max(-1, Math.min(1, player.input.throttle)) : Number(Boolean(player.input['speed-up'])) - Number(Boolean(player.input['speed-down']));
      if (throttleInput > 0) player.speed = Math.min(stats.maxSpeed, player.speed + speedChange * throttleInput);
      if (throttleInput < 0) player.speed = Math.max(stats.minSpeed, player.speed + speedChange * throttleInput);
    }
    const angle = (player.angle * Math.PI) / 180;
    // Map coordinates are pixels, so aircraft cover more than one pixel per
    // real-world meter to keep the displayed airspeed responsive in the world.
    const worldSpeed = (getSpeedKmh(player, stats) * 2.5 / 3.6) * (player.isBot ? 0.7 : 1);
    player.x += Math.sin(angle) * worldSpeed * delta;
    player.y -= Math.cos(angle) * worldSpeed * delta;

    const outsidePlayground = player.x < 0 || player.y < 0 || player.x > world.width || player.y > world.height;
    if (outsidePlayground) {
      damagePlayer(player, stats.maxHp * 0.2 * delta, null);
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
        rocket.x = owner.x + Math.sin(angle) * 57;
        rocket.y = owner.y - Math.cos(angle) * 57;
        rocket.angle = owner.angle;
      }
      rocket.active = true;
    }
    if (!rocket.active) continue;
    if (!rocket.ownerIsBot || rocket.mineLaunched) {
      let target = rocket.trackingTargetId ? players.get(rocket.trackingTargetId) : null;
      if (target) {
        const distance = Math.hypot(target.x - rocket.x, target.y - rocket.y);
        const targetAngle = (Math.atan2(target.x - rocket.x, -(target.y - rocket.y)) * 180) / Math.PI;
        const angleDelta = Math.abs(shortestAngleDelta(rocket.angle, targetAngle));
        const sameTeam = Boolean(rocket.ownerTeamId) && getEffectiveTeamId(target) === rocket.ownerTeamId;
        if (target.hp <= 0 || target.id === rocket.ownerId || distance > rocket.trackingRange || angleDelta > rocket.trackingCone || (sameTeam && !rocket.teamDamageEnabled)) target = null;
      }
      if (!target) {
        rocket.trackingTargetId = null;
        target = [...players.values()]
          .filter((candidate) => candidate.id !== rocket.ownerId && candidate.hp > 0 && !(rocket.ownerTeamId && getEffectiveTeamId(candidate) === rocket.ownerTeamId && !rocket.teamDamageEnabled))
          .map((candidate) => {
            const distance = Math.hypot(candidate.x - rocket.x, candidate.y - rocket.y);
            const angle = (Math.atan2(candidate.x - rocket.x, -(candidate.y - rocket.y)) * 180) / Math.PI;
            return { candidate, distance, angleDelta: Math.abs(shortestAngleDelta(rocket.angle, angle)) };
          })
          .filter(({ distance, angleDelta }) => distance <= rocket.trackingRange && angleDelta <= rocket.trackingCone)
          .sort((a, b) => a.angleDelta - b.angleDelta || a.distance - b.distance)[0]?.candidate ?? null;
        if (target) rocket.trackingTargetId = target.id;
      }
      if (target) {
        const targetAngle = (Math.atan2(target.x - rocket.x, -(target.y - rocket.y)) * 180) / Math.PI;
        const turn = shortestAngleDelta(rocket.angle, targetAngle);
        rocket.angle += Math.max(-rocket.turnRate * delta, Math.min(rocket.turnRate * delta, turn));
      }
    }
    const previousX = rocket.x;
    const previousY = rocket.y;
    const angle = (rocket.angle * Math.PI) / 180;
    const accelerationProgress = Math.max(0, Math.min(1, (now - rocket.launchAt) / 800));
    const maxSpeed = rocket.maxSpeed ?? (rocket.mineLaunched ? 310 : 620);
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
      const collisionRadius = (player.isBot ? 34 : 42) + 15;
      const contact = pointToSegmentDistance(player.x, player.y, previousX, previousY, rocket.x, rocket.y);
      if (contact.distance <= collisionRadius && (!impact || contact.distance < impact.distance)) impact = { ...contact, playerId: player.id };
    }
    if (impact) {
      const blastRadius = rocket.mineLaunched ? 110 : 180;
      applyBlastDamage(impact.x, impact.y, blastRadius, rocket.damage, rocket.ownerId, rocket.ownerTeamId, rocket.teamDamageEnabled, impact.playerId, true);
      spawnBlast(impact.x, impact.y, now, rocket.mineLaunched ? 0.58 : 0.8);
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
      if (relativeContact.distance <= 24) {
        const firstX = firstPath.startX + (firstPath.endX - firstPath.startX) * relativeContact.progress;
        const firstY = firstPath.startY + (firstPath.endY - firstPath.startY) * relativeContact.progress;
        const secondX = secondPath.startX + (secondPath.endX - secondPath.startX) * relativeContact.progress;
        const secondY = secondPath.startY + (secondPath.endY - secondPath.startY) * relativeContact.progress;
        destroyedRocketIds.add(firstRocket.id);
        destroyedRocketIds.add(secondRocket.id);
        spawnBlast((firstX + secondX) / 2, (firstY + secondY) / 2, now, 0.42);
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
          return distance <= (player.isBot ? 68 : 84) * 1.3 && (!sameTeam || mine.teamDamageEnabled);
        })
        .sort((a, b) => a.distance - b.distance)[0]?.player;
      if (target) {
        launchMineMissile(mine, target, now);
        mines.splice(index, 1);
        continue;
      }
    }
    if (now >= mine.expiresAt) {
      applyBlastDamage(mine.x, mine.y, 72, mine.damage * 0.35, mine.ownerId, mine.ownerTeamId, mine.teamDamageEnabled);
      spawnBlast(mine.x, mine.y, now, 0.42);
      mines.splice(index, 1);
    }
  }

  if (now - lastBroadcastAt >= 50) {
    lastBroadcastAt = now;
    broadcastSnapshot();
  }
}

setInterval(tick, 50);

server.on('listening', () => {
  console.log(`WebSocket server listening at ws://localhost:${port}`);
});

server.on('connection', (socket) => {
  console.log('Client connected');
  socket.send(JSON.stringify({ type: 'welcome', message: 'Connected to the game server!' }));
  socket.send(JSON.stringify({ type: 'world', world }));

  socket.on('message', (rawMessage) => {
    try {
      const message = JSON.parse(rawMessage.toString());
      if (message.type === 'join' && typeof message.id === 'string') {
        if (socket.playerId && socket.playerId !== message.id) players.delete(socket.playerId);
        socket.playerId = message.id;
        if (!players.has(socket.playerId)) players.set(socket.playerId, createPlayer(socket.playerId, message.name));
        const joinedPlayer = players.get(socket.playerId);
        joinedPlayer.name = String(message.name || 'Pilot').slice(0, 24);
        const teamCode = typeof message.teamCode === 'string' ? message.teamCode.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) : '';
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
    if (socket.playerId) {
      players.delete(socket.playerId);
      maintainBotPopulation();
    }
    broadcastSnapshot();
    console.log('Client disconnected');
  });
  socket.on('error', (error) => console.error('WebSocket error:', error.message));
});

server.on('error', (error) => console.error('Server error:', error.message));
