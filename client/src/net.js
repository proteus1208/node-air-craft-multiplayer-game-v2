const HISTORY_LIMIT = 40;
const CLOCK_SAMPLES = 40;
const MIN_BUFFER_MS = 60;
const MAX_BUFFER_MS = 150;
const MAX_EXTRAPOLATE_MS = 120;
const REPLAY_STEP_MS = 20;
const CORRECTION_SECONDS = 0.12;
const SNAP_DISTANCE = 300;
const SNAP_ANGLE = 75;
const zeroInput = { yaw: 0, throttle: 0 };

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const wrapAngle = (angle) => ((angle % 360) + 360) % 360;
const angleDelta = (from, to) => ((to - from + 540) % 360) - 180;

export function createNetState() {
  return {
    history: [],
    meta: new Map(),
    clock: { samples: [], offset: null, jitter: 0, interval: 33, lastServerTime: 0 },
    me: null,
    hud: null,
    inputSeq: 0,
    inputLog: [],
    predicted: null,
    predictedAt: 0,
    correction: { x: 0, y: 0, angle: 0 },
    fx: [],
    stats: {
      rtt: 0,
      snapshotRate: 0,
      byteRate: 0,
      bufferMs: 100,
      predictionError: 0,
      fps: 0,
      windowStart: 0,
      windowSnapshots: 0,
      windowBytes: 0,
    },
  };
}

export function noteBytes(net, byteLength, now) {
  const stats = net.stats;
  if (!stats.windowStart) stats.windowStart = now;
  stats.windowBytes += byteLength;
  const elapsed = now - stats.windowStart;
  if (elapsed >= 1000) {
    stats.snapshotRate = Math.round((stats.windowSnapshots * 1000) / elapsed);
    stats.byteRate = Math.round((stats.windowBytes * 1000) / elapsed);
    stats.windowStart = now;
    stats.windowSnapshots = 0;
    stats.windowBytes = 0;
  }
}

export function noteMeta(net, rows, hunt = '') {
  net.hunt = hunt || '';
  net.meta = new Map(rows.map(([id, name, teamId, level, maxHp, isBot, score, kills, planeTier, spawnedAt, teamColor, teamName, mark]) => [id, { name, teamId, level, maxHp, isBot: Boolean(isBot), score, kills, planeTier, spawnedAt, teamColor: teamColor || '', teamName: teamName || '', mark: mark || '' }]));
}

export function notePong(net, sentAt, now) {
  const sample = now - sentAt;
  net.stats.rtt = net.stats.rtt ? Math.round(net.stats.rtt * 0.7 + sample * 0.3) : Math.round(sample);
}

function noteClock(net, serverTime, arrival) {
  const clock = net.clock;
  if (clock.lastServerTime) {
    const gap = serverTime - clock.lastServerTime;
    if (gap > 0 && gap < 500) clock.interval = clock.interval * 0.9 + gap * 0.1;
  }
  clock.lastServerTime = serverTime;
  clock.samples.push(serverTime - arrival);
  if (clock.samples.length > CLOCK_SAMPLES) clock.samples.shift();
  // The least-delayed packet is the closest estimate of the clock offset; the
  // spread of the others is the network jitter.
  const offset = Math.max(...clock.samples);
  const spread = clock.samples.reduce((sum, sample) => sum + (offset - sample), 0) / clock.samples.length;
  clock.offset = offset;
  clock.jitter = clock.jitter * 0.8 + spread * 0.2;
  net.stats.bufferMs = Math.round(clamp(clock.interval * 2 + clock.jitter, MIN_BUFFER_MS, MAX_BUFFER_MS));
}

function playerFromRow(net, [id, x, y, angle, hp, flags, guardMs]) {
  const meta = net.meta.get(id);
  return {
    id,
    x,
    y,
    angle,
    hp,
    name: meta?.name ?? 'Pilot',
    teamId: meta?.teamId ?? null,
    teamName: meta?.teamName ?? '',
    teamColor: meta?.teamColor ?? '',
    level: meta?.level ?? 1,
    maxHp: meta?.maxHp ?? 100,
    isBot: meta?.isBot ?? id.startsWith('bot-'),
    score: meta?.score ?? 0,
    kills: meta?.kills ?? 0,
    mark: meta?.mark || '',
    planeTier: meta?.planeTier,
    spawnedAt: meta?.spawnedAt ?? 0,
    spawnProtectionRemainingMs: Number.isFinite(guardMs) ? guardMs : (flags & 1 ? 1 : 0),
    outOfMap: Boolean(flags & 2),
  };
}

// Turns a compact server snapshot into the object shapes the game renders and
// stores the moving parts for interpolation.
export function decodeSnapshot(net, data, arrival) {
  net.stats.windowSnapshots += 1;
  noteClock(net, data.t, arrival);
  const players = (data.p ?? []).map((row) => playerFromRow(net, row));
  const rockets = (data.r ?? []).map(([id, x, y, angle, ownerId, flags, variant, ownerTeamId, trackingTargetId]) => ({ id, x, y, angle, ownerId, ownerIsBot: Boolean(flags & 1), mineLaunched: Boolean(flags & 2), variant, ownerTeamId, trackingTargetId, active: true }));
  const mines = (data.m ?? []).map(([id, x, y, ownerId, ownerTeamId, armed, variant]) => ({ id, x, y, ownerId, ownerTeamId, armed: Boolean(armed), visible: true, variant }));
  const blasts = (data.b ?? []).map(([id, x, y, radius]) => ({ id, x, y, radius }));
  net.history.push({
    t: data.t,
    players: new Map(players.map((player) => [player.id, { x: player.x, y: player.y, angle: player.angle, spawnedAt: player.spawnedAt }])),
    rockets: new Map(rockets.map((rocket) => [rocket.id, { x: rocket.x, y: rocket.y, angle: rocket.angle }])),
  });
  if (net.history.length > HISTORY_LIMIT) net.history.shift();
  if (data.hud) net.hud = data.hud;
  if (Array.isArray(data.fx)) net.fx.push(...data.fx);
  if (data.me) reconcile(net, data.me, data.t, arrival);
  return { players, rockets, mines, blasts };
}

function lerpEntity(earlier, later, blend) {
  return {
    x: earlier.x + (later.x - earlier.x) * blend,
    y: earlier.y + (later.y - earlier.y) * blend,
    angle: earlier.angle + angleDelta(earlier.angle, later.angle) * blend,
  };
}

function sampleMap(earlierMap, laterMap, blend, extrapolate) {
  const result = new Map();
  for (const [id, later] of laterMap) {
    const earlier = earlierMap?.get(id);
    if (!earlier || (later.spawnedAt !== undefined && earlier.spawnedAt !== later.spawnedAt)) {
      result.set(id, later);
      continue;
    }
    result.set(id, extrapolate ? lerpEntity(earlier, later, 1 + blend) : lerpEntity(earlier, later, blend));
  }
  return result;
}

// Remote planes and rockets are drawn a short, adaptive delay behind the
// server so there are always two snapshots to blend between.
export function sampleRemote(net, now) {
  const history = net.history;
  if (!history.length || net.clock.offset === null) return null;
  const renderTime = now + net.clock.offset - net.stats.bufferMs;
  const last = history[history.length - 1];
  if (history.length === 1 || renderTime <= history[0].t) return { players: history[0].players, rockets: history[0].rockets };
  if (renderTime >= last.t) {
    const previous = history[history.length - 2];
    const span = Math.max(1, last.t - previous.t);
    const ahead = Math.min(renderTime - last.t, MAX_EXTRAPOLATE_MS) / span;
    return { players: sampleMap(previous.players, last.players, ahead, true), rockets: sampleMap(previous.rockets, last.rockets, ahead, true) };
  }
  let index = history.length - 2;
  while (index > 0 && history[index].t > renderTime) index -= 1;
  const earlier = history[index];
  const later = history[index + 1];
  const blend = clamp((renderTime - earlier.t) / Math.max(1, later.t - earlier.t), 0, 1);
  return { players: sampleMap(earlier.players, later.players, blend, false), rockets: sampleMap(earlier.rockets, later.rockets, blend, false) };
}

export function recordInput(net, input, now) {
  net.inputSeq += 1;
  net.inputLog.push({ seq: net.inputSeq, at: now, input: { yaw: input.yaw ?? 0, throttle: input.throttle ?? 0 } });
  if (net.inputLog.length > 400) net.inputLog.splice(0, net.inputLog.length - 400);
  return net.inputSeq;
}

export function latestInput(net) {
  return net.inputLog[net.inputLog.length - 1]?.input ?? zeroInput;
}

// Same flight math as the server's stepWorld: turn, then speed, then move.
export function stepFlight(state, input, me, seconds) {
  state.angle = wrapAngle(state.angle + me.tr * clamp(input.yaw ?? 0, -1, 1) * seconds);
  let worldKmh = me.k;
  if (me.sm) {
    const throttle = clamp(input.throttle ?? 0, -1, 1);
    if (throttle > 0) state.speed = Math.min(me.mx, state.speed + me.acc * seconds * throttle);
    if (throttle < 0) state.speed = Math.max(me.mn, state.speed + me.acc * seconds * throttle);
    worldKmh = Math.round(state.speed);
  }
  const radians = (state.angle * Math.PI) / 180;
  const worldSpeed = worldKmh * me.wk;
  state.x += Math.sin(radians) * worldSpeed * seconds;
  state.y -= Math.cos(radians) * worldSpeed * seconds;
}

function simulate(state, input, me, fromMs, toMs) {
  let time = fromMs;
  while (time < toMs) {
    const stepMs = Math.min(REPLAY_STEP_MS, toMs - time);
    stepFlight(state, input, me, stepMs / 1000);
    time += stepMs;
  }
}

// Rebuilds where the plane should be now: the server's state plus every input
// the server had not applied yet, replayed on the local timeline.
function reconcile(net, me, serverTime, arrival) {
  const log = net.inputLog;
  const acked = log.find((entry) => entry.seq === me.ack);
  const halfTrip = net.stats.rtt ? net.stats.rtt / 2 : 50;
  let startedAt = acked && me.at ? serverTime - (me.at - acked.at) : arrival - halfTrip;
  startedAt = clamp(startedAt, arrival - 500, arrival);
  const firstKept = log.findIndex((entry) => entry.seq >= me.ack);
  if (firstKept > 0) log.splice(0, firstKept);

  const target = { x: me.x, y: me.y, angle: me.a, speed: me.s };
  let input = acked?.input ?? zeroInput;
  let time = startedAt;
  for (const entry of log) {
    if (entry.seq <= me.ack) continue;
    if (entry.at > time) {
      simulate(target, input, me, time, Math.min(entry.at, arrival));
      time = Math.min(entry.at, arrival);
    }
    input = entry.input;
  }
  simulate(target, input, me, time, arrival);

  const previous = net.me;
  net.me = me;
  const predicted = net.predicted;
  if (predicted) simulate(predicted, latestInput(net), me, net.predictedAt, arrival);
  net.predictedAt = arrival;
  const respawned = !previous || previous.sp !== me.sp;
  const distance = predicted ? Math.hypot(target.x - predicted.x, target.y - predicted.y) : Infinity;
  const turnError = predicted ? Math.abs(angleDelta(predicted.angle, target.angle)) : Infinity;
  if (!predicted || respawned || me.hp <= 0 || distance > SNAP_DISTANCE || turnError > SNAP_ANGLE) {
    net.predicted = target;
    net.correction = { x: 0, y: 0, angle: 0 };
    net.stats.predictionError = 0;
    return;
  }
  net.correction = { x: target.x - predicted.x, y: target.y - predicted.y, angle: angleDelta(predicted.angle, target.angle) };
  predicted.speed = target.speed;
  net.stats.predictionError = Math.round(distance * 10) / 10;
}

// Advances the locally flown plane to `now` and eases out any correction.
export function advancePrediction(net, input, now) {
  const predicted = net.predicted;
  const me = net.me;
  if (!predicted || !me) return null;
  const elapsed = clamp(now - net.predictedAt, 0, 100);
  net.predictedAt = now;
  if (me.hp > 0) simulate(predicted, input, me, 0, elapsed);
  const share = 1 - Math.exp(-elapsed / 1000 / CORRECTION_SECONDS);
  const correction = net.correction;
  const dx = correction.x * share;
  const dy = correction.y * share;
  const da = correction.angle * share;
  predicted.x += dx;
  predicted.y += dy;
  predicted.angle = wrapAngle(predicted.angle + da);
  correction.x -= dx;
  correction.y -= dy;
  correction.angle -= da;
  return predicted;
}
