import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import { createServer as createViteServer } from 'vite';

interface Player {
  id: string;
  name: string;
  team: 'police' | 'thief' | 'spectator';
  isActive: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  isShooting: boolean;
  color: string;
  kills: number;
  deaths: number;
  lastInputAt: number;
}

interface PlayerSnapshot {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

interface Room {
  code: string;
  players: Record<string, Player>;
  history: Record<string, PlayerSnapshot[]>;
  activePlayerIds: string[];
  phase: 'waiting' | 'countdown' | 'live' | 'round_end';
  countdown: number | null;
  blueScore: number;
  redScore: number;
  roundNumber: number;
  message: string;
  countdownTimer?: NodeJS.Timeout;
  roundResetTimer?: NodeJS.Timeout;
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const app = express();

const ARENA_LIMIT = 29.8;
const MAX_PLAYER_Y = 8;
const SERVER_SYNC_LIMIT = 30.25;
const PLAYER_RADIUS = 0.45;
const MOVE_SPEED = 7.5;
const HISTORY_MS = 800;
const LAG_COMPENSATION_MS = 110;
const HIT_RADIUS = 0.82;
const MAX_SHOT_DISTANCE = 55;
const POLICE_COLOR = '#2563eb';
const THIEF_COLOR = '#dc2626';
const SPECTATOR_COLOR = '#94a3b8';

const spawnPoints = [
  { x: -22, y: 0, z: 18 },
  { x: 22, y: 0, z: 18 },
  { x: -22, y: 0, z: -18 },
  { x: 22, y: 0, z: -18 },
  { x: 0, y: 0, z: 22 },
  { x: 0, y: 0, z: -22 },
  { x: -18, y: 0, z: 0 },
  { x: 18, y: 0, z: 0 },
  { x: -8, y: 0, z: 22 },
  { x: 8, y: 0, z: -22 }
];

const obstacleRects = [
  { x: 0, z: 0, sx: 6, sz: 6 },
  { x: -12, z: -12, sx: 2.5, sz: 2.5 },
  { x: 12, z: 12, sx: 3, sz: 3 },
  { x: -15, z: 10, sx: 2, sz: 2 },
  { x: 10, z: -14, sx: 4, sz: 2 },
  { x: -24, z: -24, sx: 3, sz: 3 },
  { x: 24, z: -24, sx: 3, sz: 3 },
  { x: -24, z: 24, sx: 3, sz: 3 },
  { x: 24, z: 24, sx: 3, sz: 3 },
  { x: -18, z: -6, sx: 0.95, sz: 0.95 },
  { x: 18, z: 6, sx: 0.95, sz: 0.95 },
  { x: -6, z: 18, sx: 0.95, sz: 0.95 },
  { x: 6, z: -18, sx: 0.95, sz: 0.95 }
];

// Express CORS middleware to mirror origins and guarantee browser approval
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-requested-with');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

const httpServer = createServer(app);

// Configure Socket.IO with relaxed, credentials-enabled CORS so client can connect safely
const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      // Safely mirror the requester origin to fully bypass CORS restrictions
      callback(null, origin || true);
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

// Server store for rooms and socket associations
const rooms: Record<string, Room> = {};
const socketToRoom: Record<string, string> = {};

// Helper: Generate a unique 5-character uppercase alpha-numeric room token
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]);
  return code;
}

// Helper: Random hex color for player representation
function getRandomColor(): string {
  const colors = [
    '#f87171', '#fb923c', '#fbbf24', '#facc15', '#a3e635', 
    '#4ade80', '#34d399', '#2dd4bf', '#22d3ee', '#38bdf8', 
    '#60a5fa', '#818cf8', '#a78bfa', '#c084fc', '#f472b6', '#fb7185'
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

function getSpawnPoint(room?: Room): { x: number; y: number; z: number } {
  const occupied = new Set(
    room ? Object.values(room.players).map((player) => `${Math.round(player.x)}:${Math.round(player.z)}`) : []
  );

  const candidates = spawnPoints.filter((point) => !occupied.has(`${Math.round(point.x)}:${Math.round(point.z)}`));
  const point = candidates.length ? candidates[Math.floor(Math.random() * candidates.length)] : spawnPoints[Math.floor(Math.random() * spawnPoints.length)];
  return { ...point };
}

function sanitizePlayerSync(player: Player, data: { x: number; y: number; z: number; yaw: number; pitch: number; isShooting: boolean }): boolean {
  if (![data.x, data.y, data.z, data.yaw, data.pitch].every(Number.isFinite)) {
    return false;
  }

  player.x = Math.max(-SERVER_SYNC_LIMIT, Math.min(SERVER_SYNC_LIMIT, data.x));
  player.y = Math.max(0, Math.min(MAX_PLAYER_Y, data.y));
  player.z = Math.max(-SERVER_SYNC_LIMIT, Math.min(SERVER_SYNC_LIMIT, data.z));
  player.yaw = data.yaw;
  player.pitch = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, data.pitch));
  player.isShooting = Boolean(data.isShooting);

  return true;
}

function isBlockedXZ(x: number, z: number): boolean {
  if (x < -ARENA_LIMIT || x > ARENA_LIMIT || z < -ARENA_LIMIT || z > ARENA_LIMIT) {
    return true;
  }

  return obstacleRects.some((rect) => {
    const halfX = rect.sx / 2 + PLAYER_RADIUS;
    const halfZ = rect.sz / 2 + PLAYER_RADIUS;
    return x >= rect.x - halfX && x <= rect.x + halfX && z >= rect.z - halfZ && z <= rect.z + halfZ;
  });
}

function applyPlayerInput(player: Player, data: { moveX: number; moveZ: number; yaw: number; pitch: number; isShooting?: boolean }, now = Date.now()) {
  if (![data.moveX, data.moveZ, data.yaw, data.pitch].every(Number.isFinite)) {
    return false;
  }

  const dt = Math.max(0, Math.min(0.05, (now - (player.lastInputAt || now)) / 1000));
  player.lastInputAt = now;
  player.yaw = data.yaw;
  player.pitch = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, data.pitch));
  player.isShooting = Boolean(data.isShooting);

  const inputLen = Math.hypot(data.moveX, data.moveZ);
  if (inputLen <= 0.001 || dt <= 0) return true;

  const moveX = data.moveX / Math.max(1, inputLen);
  const moveZ = data.moveZ / Math.max(1, inputLen);
  const forward = {
    x: -Math.sin(player.yaw),
    z: -Math.cos(player.yaw)
  };
  const right = {
    x: Math.cos(player.yaw),
    z: -Math.sin(player.yaw)
  };

  const dx = (right.x * moveX + forward.x * -moveZ) * MOVE_SPEED * dt;
  const dz = (right.z * moveX + forward.z * -moveZ) * MOVE_SPEED * dt;
  const nextX = Math.max(-SERVER_SYNC_LIMIT, Math.min(SERVER_SYNC_LIMIT, player.x + dx));
  if (!isBlockedXZ(nextX, player.z)) {
    player.x = nextX;
  }

  const nextZ = Math.max(-SERVER_SYNC_LIMIT, Math.min(SERVER_SYNC_LIMIT, player.z + dz));
  if (!isBlockedXZ(player.x, nextZ)) {
    player.z = nextZ;
  }

  return true;
}

function recordPlayerSnapshot(room: Room, player: Player, t = Date.now()) {
  if (!room.history[player.id]) {
    room.history[player.id] = [];
  }

  const history = room.history[player.id];
  history.push({
    t,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    pitch: player.pitch
  });

  while (history.length > 2 && t - history[0].t > HISTORY_MS) {
    history.shift();
  }
}

function getRewoundSnapshot(room: Room, player: Player, targetTime: number): PlayerSnapshot {
  const history = room.history[player.id] || [];
  if (history.length === 0) {
    return {
      t: targetTime,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch
    };
  }

  let before = history[0];
  let after = history[history.length - 1];
  for (let i = 0; i < history.length; i++) {
    const sample = history[i];
    if (sample.t <= targetTime) {
      before = sample;
    }
    if (sample.t >= targetTime) {
      after = sample;
      break;
    }
  }

  if (before.t === after.t) return before;
  const alpha = Math.max(0, Math.min(1, (targetTime - before.t) / (after.t - before.t)));
  return {
    t: targetTime,
    x: before.x + (after.x - before.x) * alpha,
    y: before.y + (after.y - before.y) * alpha,
    z: before.z + (after.z - before.z) * alpha,
    yaw: before.yaw + (after.yaw - before.yaw) * alpha,
    pitch: before.pitch + (after.pitch - before.pitch) * alpha
  };
}

function getShotRay(attacker: Player) {
  const pitch = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, attacker.pitch));
  const cosPitch = Math.cos(pitch);
  return {
    origin: {
      x: attacker.x,
      y: attacker.y + 1.6,
      z: attacker.z
    },
    dir: {
      x: -Math.sin(attacker.yaw) * cosPitch,
      y: Math.sin(pitch),
      z: -Math.cos(attacker.yaw) * cosPitch
    }
  };
}

function getRayHitDistance(ray: ReturnType<typeof getShotRay>, snapshot: PlayerSnapshot): number | null {
  const center = {
    x: snapshot.x,
    y: snapshot.y + 1.0,
    z: snapshot.z
  };
  const toTarget = {
    x: center.x - ray.origin.x,
    y: center.y - ray.origin.y,
    z: center.z - ray.origin.z
  };
  const alongRay = toTarget.x * ray.dir.x + toTarget.y * ray.dir.y + toTarget.z * ray.dir.z;
  if (alongRay < 0 || alongRay > MAX_SHOT_DISTANCE) return null;

  const closest = {
    x: ray.origin.x + ray.dir.x * alongRay,
    y: ray.origin.y + ray.dir.y * alongRay,
    z: ray.origin.z + ray.dir.z * alongRay
  };
  const dx = center.x - closest.x;
  const dy = center.y - closest.y;
  const dz = center.z - closest.z;
  const distanceToRay = Math.sqrt(dx * dx + dy * dy + dz * dz);

  return distanceToRay <= HIT_RADIUS ? alongRay : null;
}

function rayIntersectsObstacleBefore(ray: ReturnType<typeof getShotRay>, maxDistance: number): boolean {
  return obstacleRects.some((rect) => {
    const minX = rect.x - rect.sx / 2;
    const maxX = rect.x + rect.sx / 2;
    const minZ = rect.z - rect.sz / 2;
    const maxZ = rect.z + rect.sz / 2;
    let tMin = 0;
    let tMax = maxDistance;

    if (Math.abs(ray.dir.x) < 0.0001) {
      if (ray.origin.x < minX || ray.origin.x > maxX) return false;
    } else {
      const tx1 = (minX - ray.origin.x) / ray.dir.x;
      const tx2 = (maxX - ray.origin.x) / ray.dir.x;
      tMin = Math.max(tMin, Math.min(tx1, tx2));
      tMax = Math.min(tMax, Math.max(tx1, tx2));
    }

    if (Math.abs(ray.dir.z) < 0.0001) {
      if (ray.origin.z < minZ || ray.origin.z > maxZ) return false;
    } else {
      const tz1 = (minZ - ray.origin.z) / ray.dir.z;
      const tz2 = (maxZ - ray.origin.z) / ray.dir.z;
      tMin = Math.max(tMin, Math.min(tz1, tz2));
      tMax = Math.min(tMax, Math.max(tz1, tz2));
    }

    return tMax >= tMin && tMin > 0.1 && tMin < maxDistance;
  });
}

function getMatchState(room: Room) {
  return {
    phase: room.phase,
    countdown: room.countdown,
    blueScore: room.blueScore,
    redScore: room.redScore,
    roundNumber: room.roundNumber,
    message: room.message,
    activePlayerIds: room.activePlayerIds
  };
}

function emitRoomState(roomCode: string) {
  const room = rooms[roomCode];
  if (!room) return;
  io.in(roomCode).emit('players:sync', {
    players: room.players,
    match: getMatchState(room)
  });
  io.in(roomCode).emit('match:state', getMatchState(room));
}

function applyDamage(roomCode: string, attacker: Player, victim: Player, damage: number) {
  const room = rooms[roomCode];
  if (!room || victim.health <= 0) return;

  victim.health = Math.max(0, victim.health - damage);
  io.in(roomCode).emit('player:health', {
    id: victim.id,
    health: victim.health
  });

  if (victim.health <= 0) {
    attacker.kills += 1;
    victim.deaths += 1;

    io.in(roomCode).emit('player:eliminated', {
      victimId: victim.id,
      victimName: victim.name,
      attackerId: attacker.id,
      attackerName: attacker.name,
      kills: attacker.kills
    });

    endRound(roomCode, attacker, victim);
  }
}

function setActiveDuel(room: Room, activeIds: string[]) {
  room.activePlayerIds = activeIds.slice(0, 2);

  Object.values(room.players).forEach((player) => {
    const activeIndex = room.activePlayerIds.indexOf(player.id);
    player.isActive = activeIndex !== -1;
    player.team = activeIndex === 0 ? 'police' : activeIndex === 1 ? 'thief' : 'spectator';
    player.color = activeIndex === 0 ? POLICE_COLOR : activeIndex === 1 ? THIEF_COLOR : SPECTATOR_COLOR;
    player.health = 100;
    player.isShooting = false;
  });

  room.activePlayerIds.forEach((playerId, index) => {
    const player = room.players[playerId];
    const spawn = spawnPoints[index === 0 ? 0 : 1];
    if (player) {
      player.x = spawn.x;
      player.y = spawn.y;
      player.z = spawn.z;
      player.yaw = index === 0 ? Math.PI : 0;
      player.pitch = 0;
      player.lastInputAt = Date.now();
      room.history[player.id] = [];
      recordPlayerSnapshot(room, player);
    }
  });
}

function clearRoomTimers(room: Room) {
  if (room.countdownTimer) {
    clearInterval(room.countdownTimer);
    room.countdownTimer = undefined;
  }
  if (room.roundResetTimer) {
    clearTimeout(room.roundResetTimer);
    room.roundResetTimer = undefined;
  }
}

function startCountdown(roomCode: string) {
  const room = rooms[roomCode];
  if (!room || room.activePlayerIds.length < 2) return;

  clearRoomTimers(room);
  setActiveDuel(room, room.activePlayerIds);
  room.roundNumber += 1;
  room.phase = 'countdown';
  room.countdown = 3;
  room.message = 'Prepare-se';
  emitRoomState(roomCode);
  room.activePlayerIds.forEach((playerId) => {
    const player = room.players[playerId];
    if (!player) return;
    io.to(playerId).emit('player:respawned', {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      health: player.health
    });
  });

  room.countdownTimer = setInterval(() => {
    const latestRoom = rooms[roomCode];
    if (!latestRoom) return;

    if ((latestRoom.countdown || 0) > 1) {
      latestRoom.countdown = (latestRoom.countdown || 1) - 1;
      latestRoom.message = 'Prepare-se';
      emitRoomState(roomCode);
      return;
    }

    clearRoomTimers(latestRoom);
    latestRoom.phase = 'live';
    latestRoom.countdown = null;
    latestRoom.message = 'GO';
    emitRoomState(roomCode);
  }, 1000);
}

function fillActiveSlots(room: Room, preferredWinnerId?: string) {
  const connectedIds = Object.keys(room.players);
  const nextActive: string[] = [];

  if (preferredWinnerId && room.players[preferredWinnerId]) {
    nextActive.push(preferredWinnerId);
  }

  const waitingIds = connectedIds.filter((id) => id !== preferredWinnerId && !room.activePlayerIds.includes(id));
  const previousOpponentIds = connectedIds.filter((id) => id !== preferredWinnerId && room.activePlayerIds.includes(id));

  [...waitingIds, ...previousOpponentIds].forEach((id) => {
    if (nextActive.length < 2 && !nextActive.includes(id)) {
      nextActive.push(id);
    }
  });

  setActiveDuel(room, nextActive);
}

function waitOrStart(roomCode: string, preferredWinnerId?: string) {
  const room = rooms[roomCode];
  if (!room) return;

  clearRoomTimers(room);
  fillActiveSlots(room, preferredWinnerId);

  if (room.activePlayerIds.length >= 2) {
    startCountdown(roomCode);
  } else {
    room.phase = 'waiting';
    room.countdown = null;
    room.message = 'Aguardando segundo jogador';
    emitRoomState(roomCode);
  }
}

function endRound(roomCode: string, winner: Player, loser: Player) {
  const room = rooms[roomCode];
  if (!room || room.phase === 'round_end') return;

  clearRoomTimers(room);
  if (winner.team === 'police') {
    room.blueScore += 1;
  } else if (winner.team === 'thief') {
    room.redScore += 1;
  }

  room.phase = 'round_end';
  room.countdown = null;
  room.message = `${winner.name} venceu o round`;
  winner.health = 100;
  loser.health = 0;
  emitRoomState(roomCode);

  room.roundResetTimer = setTimeout(() => {
    waitOrStart(roomCode, winner.id);
  }, 3000);
}

function removePlayerFromRoom(socket: Socket) {
  const roomCode = socketToRoom[socket.id];
  if (!roomCode || !rooms[roomCode]) return;

  const room = rooms[roomCode];
  const player = room.players[socket.id];
  const pName = player ? player.name : 'Unknown';

  delete room.players[socket.id];
  delete socketToRoom[socket.id];
  room.activePlayerIds = room.activePlayerIds.filter((id) => id !== socket.id);
  socket.leave(roomCode);

  socket.to(roomCode).emit('player:disconnected', {
    id: socket.id,
    name: pName
  });

  if (Object.keys(room.players).length === 0) {
    clearRoomTimers(room);
    delete rooms[roomCode];
    console.log(`🏠 Room ${roomCode} is now empty and has been removed.`);
  } else if (room.activePlayerIds.length < 2) {
    waitOrStart(roomCode);
  } else {
    emitRoomState(roomCode);
  }
}

// Socket.IO real-time multiplayer logic
io.on('connection', (socket: Socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Create Room
  socket.on('room:create', ({ name }: { name: string }) => {
    removePlayerFromRoom(socket);

    const code = generateRoomCode();
    const playerName = (name && name.trim()) ? name.substring(0, 12) : `Player_${socket.id.substring(0, 4)}`;
    const spawn = getSpawnPoint();
    
    rooms[code] = {
      code,
      activePlayerIds: [socket.id],
      phase: 'waiting',
      countdown: null,
      blueScore: 0,
      redScore: 0,
      roundNumber: 0,
      message: 'Aguardando segundo jogador',
      history: {},
      players: {
        [socket.id]: {
          id: socket.id,
          name: playerName,
          team: 'police',
          isActive: true,
          x: spawn.x,
          y: spawn.y,
          z: spawn.z,
          yaw: 0,
          pitch: 0,
          health: 100,
          isShooting: false,
          color: POLICE_COLOR,
          kills: 0,
          deaths: 0,
          lastInputAt: Date.now()
        }
      }
    };
    recordPlayerSnapshot(rooms[code], rooms[code].players[socket.id]);

    socketToRoom[socket.id] = code;
    socket.join(code);

    socket.emit('room:joined', {
      success: true,
      roomCode: code,
      playerId: socket.id,
      players: rooms[code].players,
      match: getMatchState(rooms[code])
    });

    console.log(`🏠 Room ${code} created by ${playerName} (${socket.id})`);
  });

  // Join Room
  socket.on('room:join', ({ name, code }: { name: string; code: string }) => {
    const upperCode = code ? code.toUpperCase().trim() : '';
    removePlayerFromRoom(socket);

    const room = rooms[upperCode];

    if (!room) {
      socket.emit('room:joined', { success: false, error: 'Room not found.' });
      return;
    }

    const playerName = (name && name.trim()) ? name.substring(0, 12) : `Player_${socket.id.substring(0, 4)}`;
    const joinsActiveRound = room.activePlayerIds.length < 2 && room.phase !== 'live';
    const spawn = getSpawnPoint(room);
    
    // Add player to the room
    const newPlayer: Player = {
      id: socket.id,
      name: playerName,
      team: joinsActiveRound ? (room.activePlayerIds.length === 0 ? 'police' : 'thief') : 'spectator',
      isActive: joinsActiveRound,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: 0,
      pitch: 0,
      health: 100,
      isShooting: false,
      color: joinsActiveRound ? (room.activePlayerIds.length === 0 ? POLICE_COLOR : THIEF_COLOR) : SPECTATOR_COLOR,
      kills: 0,
      deaths: 0,
      lastInputAt: Date.now()
    };

    room.players[socket.id] = newPlayer;
    recordPlayerSnapshot(room, newPlayer);
    if (joinsActiveRound) {
      room.activePlayerIds.push(socket.id);
    }
    socketToRoom[socket.id] = upperCode;
    socket.join(upperCode);

    // Reply to the joining player
    socket.emit('room:joined', {
      success: true,
      roomCode: upperCode,
      playerId: socket.id,
      players: room.players,
      match: getMatchState(room)
    });

    emitRoomState(upperCode);
    if (joinsActiveRound && room.activePlayerIds.length === 2) {
      startCountdown(upperCode);
    }

    console.log(`👤 Player ${playerName} joined room ${upperCode}`);
  });

  const broadcastPlayerSnapshot = (roomCode: string, player: Player) => {
    socket.to(roomCode).emit('player:sync', {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      isShooting: player.isShooting
    });
  };

  // CS-style: client sends movement intent, server owns the official position.
  socket.on('player:input', (data: { moveX: number; moveZ: number; yaw: number; pitch: number; isShooting?: boolean }) => {
    const roomCode = socketToRoom[socket.id];
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    const player = room.players[socket.id];
    if (!player) return;
    if (!player.isActive || room.phase !== 'live') return;

    if (!applyPlayerInput(player, data)) return;
    recordPlayerSnapshot(room, player);
    broadcastPlayerSnapshot(roomCode, player);
  });

  // Compatibility while old clients finish deploying.
  socket.on('player:sync', (data: { x: number; y: number; z: number; yaw: number; pitch: number; isShooting: boolean }) => {
    const roomCode = socketToRoom[socket.id];
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    const player = room.players[socket.id];
    if (!player) return;
    if (!player.isActive || room.phase !== 'live') return;

    if (!sanitizePlayerSync(player, data)) return;
    recordPlayerSnapshot(room, player);
    broadcastPlayerSnapshot(roomCode, player);
  });

  // Handle shooting trigger visual events
  socket.on('player:shoot', () => {
    const roomCode = socketToRoom[socket.id];
    if (!roomCode) return;
    const room = rooms[roomCode];
    const player = room?.players[socket.id];
    if (!room || !player?.isActive || room.phase !== 'live') return;

    // Broadcast the muzzle flash/laser visual indicator to everyone else
    socket.to(roomCode).emit('player:shoot', {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch
    });

    const ray = getShotRay(player);
    const rewindTime = Date.now() - LAG_COMPENSATION_MS;
    let bestHit: { victim: Player; distance: number } | null = null;

    room.activePlayerIds.forEach((playerId) => {
      if (playerId === socket.id) return;
      const victim = room.players[playerId];
      if (!victim || !victim.isActive || victim.health <= 0) return;

      const rewindSnapshot = getRewoundSnapshot(room, victim, rewindTime);
      const distance = getRayHitDistance(ray, rewindSnapshot);
      if (distance === null) return;
      if (rayIntersectsObstacleBefore(ray, distance)) return;
      if (!bestHit || distance < bestHit.distance) {
        bestHit = { victim, distance };
      }
    });

    if (bestHit) {
      applyDamage(roomCode, player, bestHit.victim, 25);
    }
  });

  // Damage is server-authoritative through player:shoot with lag compensation.
  socket.on('player:hit', (data: { victimId: string; damage: number }) => {
    return;
  });

  socket.on('player:respawn', () => {
    const roomCode = socketToRoom[socket.id];
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    const player = room.players[socket.id];
    if (!player) return;
    if (!player.isActive) return;

    const spawn = getSpawnPoint(room);
    player.health = 100;
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;
    player.yaw = 0;
    player.pitch = 0;
    player.isShooting = false;
    player.lastInputAt = Date.now();
    room.history[player.id] = [];
    recordPlayerSnapshot(room, player);

    io.in(roomCode).emit('player:respawned', {
      id: player.id,
      x: player.x,
      y: player.y,
      z: player.z,
      health: player.health
    });
  });

  socket.on('room:leave', () => {
    removePlayerFromRoom(socket);
  });

  // Disconnections
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    removePlayerFromRoom(socket);
  });
});

// Serve APIs or general static routes BEFORE Vite
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    activeRooms: Object.keys(rooms).length
  });
});

// Integrate Vite middleware for smooth local hosting
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Combined Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
