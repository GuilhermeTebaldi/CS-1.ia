import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

// ES Module pathname helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Player {
  id: string;
  name: string;
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
}

interface Room {
  code: string;
  players: Record<string, Player>;
}

const PORT = 3000;
const app = express();
const httpServer = createServer(app);

// Configure Socket.IO with relaxed CORS so client can connect safely
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
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

// Socket.IO real-time multiplayer logic
io.on('connection', (socket: Socket) => {
  console.log(`🔌 Client connected: ${socket.id}`);

  // Create Room
  socket.on('room:create', ({ name }: { name: string }) => {
    const code = generateRoomCode();
    const playerName = (name && name.trim()) ? name.substring(0, 12) : `Player_${socket.id.substring(0, 4)}`;
    
    rooms[code] = {
      code,
      players: {
        [socket.id]: {
          id: socket.id,
          name: playerName,
          x: (Math.random() * 20) - 10,
          y: 1.0, // Eye-level height
          z: (Math.random() * 20) - 10,
          yaw: 0,
          pitch: 0,
          health: 100,
          isShooting: false,
          color: getRandomColor(),
          kills: 0,
          deaths: 0
        }
      }
    };

    socketToRoom[socket.id] = code;
    socket.join(code);

    socket.emit('room:joined', {
      success: true,
      roomCode: code,
      playerId: socket.id,
      players: rooms[code].players
    });

    console.log(`🏠 Room ${code} created by ${playerName} (${socket.id})`);
  });

  // Join Room
  socket.on('room:join', ({ name, code }: { name: string; code: string }) => {
    const upperCode = code ? code.toUpperCase().trim() : '';
    const room = rooms[upperCode];

    if (!room) {
      socket.emit('room:joined', { success: false, error: 'Room not found.' });
      return;
    }

    const playerName = (name && name.trim()) ? name.substring(0, 12) : `Player_${socket.id.substring(0, 4)}`;
    
    // Add player to the room
    const newPlayer: Player = {
      id: socket.id,
      name: playerName,
      x: (Math.random() * 20) - 10,
      y: 1.0,
      z: (Math.random() * 20) - 10,
      yaw: 0,
      pitch: 0,
      health: 100,
      isShooting: false,
      color: getRandomColor(),
      kills: 0,
      deaths: 0
    };

    room.players[socket.id] = newPlayer;
    socketToRoom[socket.id] = upperCode;
    socket.join(upperCode);

    // Reply to the joining player
    socket.emit('room:joined', {
      success: true,
      roomCode: upperCode,
      playerId: socket.id,
      players: room.players
    });

    // Broadcast updated player list to other room players
    socket.to(upperCode).emit('players:sync', {
      players: room.players
    });

    console.log(`👤 Player ${playerName} joined room ${upperCode}`);
  });

  // Handle position/rotation synchronizations
  socket.on('player:sync', (data: { x: number; y: number; z: number; yaw: number; pitch: number; isShooting: boolean }) => {
    const roomCode = socketToRoom[socket.id];
    if (!roomCode || !rooms[roomCode]) return;

    const player = rooms[roomCode].players[socket.id];
    if (!player) return;

    // Update server state memory
    player.x = data.x;
    player.y = data.y;
    player.z = data.z;
    player.yaw = data.yaw;
    player.pitch = data.pitch;
    player.isShooting = data.isShooting;

    // Broadcast update to other players in the room immediately
    socket.to(roomCode).emit('player:sync', {
      id: socket.id,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      pitch: player.pitch,
      isShooting: player.isShooting
    });
  });

  // Handle shooting trigger visual events
  socket.on('player:shoot', () => {
    const roomCode = socketToRoom[socket.id];
    if (!roomCode) return;

    // Broadcast the muzzle flash/laser visual indicator to everyone else
    socket.to(roomCode).emit('player:shoot', { id: socket.id });
  });

  // Client-authoritative damage registration (extremely robust for fast web interactions)
  socket.on('player:hit', (data: { victimId: string; damage: number }) => {
    const roomCode = socketToRoom[socket.id];
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    const victim = room.players[data.victimId];
    const attacker = room.players[socket.id];

    if (!victim || !attacker) return;
    if (victim.health <= 0) return; // Already dead

    // Reduce health
    victim.health = Math.max(0, victim.health - data.damage);
    console.log(`💥 Hit registered: Attacker ${attacker.name} -> Victim ${victim.name} (Health left: ${victim.health})`);

    // Broadcast the update immediately
    io.in(roomCode).emit('player:health', {
      id: victim.id,
      health: victim.health
    });

    // Check if dead
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

      // Respawn the player after a tiny timer or instantly on server state
      setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].players[victim.id]) {
          const respawned = rooms[roomCode].players[victim.id];
          respawned.health = 100;
          respawned.x = (Math.random() * 20) - 10;
          respawned.y = 1.0;
          respawned.z = (Math.random() * 20) - 10;
          respawned.yaw = 0;
          respawned.pitch = 0;

          // Broadcast respawn
          io.in(roomCode).emit('player:respawned', {
            id: respawned.id,
            x: respawned.x,
            y: respawned.y,
            z: respawned.z,
            health: 100
          });
        }
      }, 1000); // 1-second delay for feedback before spawning back in
    }
  });

  // Disconnections
  socket.on('disconnect', () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    const roomCode = socketToRoom[socket.id];

    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];
      const player = room.players[socket.id];
      const pName = player ? player.name : 'Unknown';

      // Delete player
      delete room.players[socket.id];
      delete socketToRoom[socket.id];

      // Notify others
      socket.to(roomCode).emit('player:disconnected', {
        id: socket.id,
        name: pName
      });

      // Synchronize latest player structure to remaining players
      socket.to(roomCode).emit('players:sync', {
        players: room.players
      });

      // If room is empty, clear it out of server memory
      if (Object.keys(room.players).length === 0) {
        delete rooms[roomCode];
        console.log(`🏠 Room ${roomCode} is now empty and has been removed.`);
      }
    }
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
