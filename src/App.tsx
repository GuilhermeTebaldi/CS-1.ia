import React, { useState, useEffect, useRef } from 'react';
import { 
  Keyboard, 
  User, 
  Hash, 
  Users, 
  Heart, 
  Tv, 
  HelpCircle, 
  LogOut, 
  Zap, 
  Copy, 
  Check, 
  Award,
  CircleDot,
  Volume2,
  Sword,
  Target
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';
import { PlayerState, KillFeedEntry } from './types';

// Procedural audio generation using standard Web Audio API (extremely robust & visual feedback)
const playGunshotSound = () => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    // Create random noise buffer for retro explosions/clicks
    const bufferSize = audioCtx.sampleRate * 0.12; // short snap
    const buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const whiteNoise = audioCtx.createBufferSource();
    whiteNoise.buffer = buffer;

    // Filter to sweep the frequencies down
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1200, audioCtx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(10, audioCtx.currentTime + 0.11);
    filter.Q.setValueAtTime(4.0, audioCtx.currentTime);

    // Fade volume
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0.35, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.12);

    whiteNoise.connect(filter);
    filter.connect(gain);
    gain.connect(audioCtx.destination);

    whiteNoise.start();
    whiteNoise.stop(audioCtx.currentTime + 0.12);
  } catch (err) {
    // browser auto-play policy catch
  }
};

const playHitSound = () => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(620, audioCtx.currentTime);
    osc.frequency.setValueAtTime(410, audioCtx.currentTime + 0.04);
    
    gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
  } catch (err) {}
};

const playEliminationSound = () => {
  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    const notes = [261.63, 329.63, 392.00, 523.25]; // Major chord C-E-G-C
    notes.forEach((freq, idx) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq, audioCtx.currentTime + idx * 0.08);
      
      gain.gain.setValueAtTime(0, audioCtx.currentTime);
      gain.gain.linearRampToValueAtTime(0.12, audioCtx.currentTime + idx * 0.08 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + idx * 0.08 + 0.25);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      osc.start(audioCtx.currentTime + idx * 0.08);
      osc.stop(audioCtx.currentTime + idx * 0.08 + 0.3);
    });
  } catch (err) {}
};

export default function App() {
  // Lobby States
  const [inGame, setInGame] = useState(false);
  const [playerName, setPlayerName] = useState(() => {
    return localStorage.getItem('blocky_fps_player_name') || `Recruta_${Math.floor(1000 + Math.random() * 9000)}`;
  });
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [currentRoom, setCurrentRoom] = useState('');
  const [localPlayerId, setLocalPlayerId] = useState('');
  const [joinedPlayers, setJoinedPlayers] = useState<Record<string, PlayerState>>({});
  const [joinError, setJoinError] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);

  // Server Configuration states (highly robust for external connections e.g. Vercel client connecting to this Cloud Run backend)
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => {
    return localStorage.getItem('blocky_fps_server_url') || window.location.origin;
  });
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('connecting');

  // Gameplay HUD states
  const [localHealth, setLocalHealth] = useState(100);
  const [localHealthFlashAlert, setLocalHealthFlashAlert] = useState(false);
  const [isHitmarkerActive, setIsHitmarkerActive] = useState(false);
  const [killFeed, setKillFeed] = useState<KillFeedEntry[]>([]);
  const [isScoreboardOpen, setIsScoreboardOpen] = useState(false);
  const [pointerLocked, setPointerLocked] = useState(false);

  // References to communicate with Three.js loops
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);

  // Mutable refs for active local physics
  const stateRef = useRef({
    x: 0,
    y: 1.6, // Default eye-level height in Three.js units
    z: 0,
    yaw: 0,
    pitch: 0,
    vy: 0, // Vertical leaping velocity
    isGrounded: true,
    isShooting: false,
    health: 100
  });

  // Keep player dict up to date for the HUD rendering / Name tags
  const joinedPlayersRef = useRef<Record<string, PlayerState>>({});
  useEffect(() => {
    joinedPlayersRef.current = joinedPlayers;
  }, [joinedPlayers]);

  // Update client-side local health representation
  useEffect(() => {
    stateRef.current.health = localHealth;
  }, [localHealth]);

  // Save Name on Change
  const handleNameChange = (val: string) => {
    const lim = val.slice(0, 15);
    setPlayerName(lim);
    localStorage.setItem('blocky_fps_player_name', lim);
  };

  // Socket setup (only during connection setups)
  useEffect(() => {
    setConnectionStatus('connecting');
    // clean up any trailing slash to avoid connection errors, default to origin space
    const cleanedUrl = serverUrl ? serverUrl.trim().replace(/\/$/, "") : window.location.origin;
    console.log("🔌 Conectando ao servidor Socket.IO:", cleanedUrl);
    
    const socket = io(cleanedUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
      timeout: 10000
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log("🔌 Conectado ao socket com ID:", socket.id);
      setConnectionStatus('connected');
      setJoinError('');
    });

    socket.on('disconnect', () => {
      console.log("🔌 Desconectado do socket.");
      setConnectionStatus('disconnected');
    });

    socket.on('connect_error', (err) => {
      console.error("🔌 Erro na conexão socket:", err);
      setConnectionStatus('error');
      setJoinError(`Conexão ao servidor falhou em ${cleanedUrl}. Motivo: ${err.message || 'websocket error'}. Verifique se esse backend Socket.IO está online.`);
    });

    socket.on('room:joined', (data: { success: boolean; roomCode: string; playerId: string; players: Record<string, PlayerState>; error?: string }) => {
      if (data.success) {
        setLocalPlayerId(data.playerId);
        setCurrentRoom(data.roomCode);
        setJoinedPlayers(data.players);
        setLocalHealth(100);
        stateRef.current.health = 100;
        setInGame(true);
        setJoinError('');
      } else {
        setJoinError(data.error || 'Não foi possível entrar na sala.');
      }
    });

    socket.on('players:sync', (data: { players: Record<string, PlayerState> }) => {
      setJoinedPlayers(data.players);
    });

    socket.on('player:health', (data: { id: string; health: number }) => {
      if (data.id === socket.id) {
        setLocalHealth(data.health);
        
        // Visual blood overlay flash on taking damage
        setLocalHealthFlashAlert(true);
        setTimeout(() => setLocalHealthFlashAlert(false), 200);
        playHitSound();
      }
      
      setJoinedPlayers(prev => {
        if (!prev[data.id]) return prev;
        return {
          ...prev,
          [data.id]: {
            ...prev[data.id],
            health: data.health
          }
        };
      });
    });

    socket.on('player:eliminated', (data: { victimId: string; victimName: string; attackerId: string; attackerName: string; kills: number }) => {
      // Append kill feed
      const newFeed: KillFeedEntry = {
        id: Math.random().toString(),
        attacker: data.attackerName,
        victim: data.victimName,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      
      setKillFeed(prev => [newFeed, ...prev].slice(0, 5));
      playEliminationSound();

      // Clear that entry after 4.5 seconds
      setTimeout(() => {
        setKillFeed(prev => prev.filter(f => f.id !== newFeed.id));
      }, 4500);

      // Clean up server side kills and updates
      setJoinedPlayers(prev => {
        const next = { ...prev };
        if (next[data.attackerId]) {
          next[data.attackerId].kills = data.kills;
        }
        if (next[data.victimId]) {
          next[data.victimId].deaths += 1;
        }
        return next;
      });
    });

    socket.on('player:respawned', (data: { id: string; x: number; y: number; z: number; health: number }) => {
      if (data.id === socket.id) {
        setLocalHealth(100);
        stateRef.current.health = 100;
        stateRef.current.x = data.x;
        stateRef.current.y = data.y + 0.6; // camera height compensation
        stateRef.current.z = data.z;
        stateRef.current.vy = 0;
        stateRef.current.isGrounded = true;
      }

      setJoinedPlayers(prev => {
        if (!prev[data.id]) return prev;
        return {
          ...prev,
          [data.id]: {
            ...prev[data.id],
            health: 100,
            x: data.x,
            y: data.y,
            z: data.z
          }
        };
      });
    });

    return () => {
      socket.disconnect();
    };
  }, [serverUrl]);

  // Handle Create and Join Room functions
  const createRoom = () => {
    if (!playerName.trim()) {
      setJoinError('Por favor, digite um nome válido primeiro.');
      return;
    }
    if (socketRef.current) {
      socketRef.current.emit('room:create', { name: playerName });
    }
  };

  const joinRoom = () => {
    if (!playerName.trim()) {
      setJoinError('Por favor, digite um nome válido primeiro.');
      return;
    }
    if (!roomCodeInput.trim()) {
      setJoinError('Por favor, insira o código da sala de 5 letras.');
      return;
    }
    if (socketRef.current) {
      socketRef.current.emit('room:join', { name: playerName, code: roomCodeInput });
    }
  };

  const leaveGame = () => {
    setInGame(false);
    setCurrentRoom('');
    setLocalPlayerId('');
    setJoinedPlayers({});
    setRoomCodeInput('');
    setPointerLocked(false);
    document.exitPointerLock?.();
  };

  const startPracticeMode = () => {
    if (!playerName.trim()) {
      setJoinError('Por favor, digite um nome válido primeiro.');
      return;
    }
    const soloId = 'solo';
    setLocalPlayerId(soloId);
    setCurrentRoom('TREINO');
    
    const selfPlayer: PlayerState = {
      id: soloId,
      name: playerName.trim(),
      health: 100,
      kills: 0,
      deaths: 0,
      color: '#3b82f6',
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      isShooting: false
    };

    const dummyPlayer: PlayerState = {
      id: 'dummy',
      name: 'Alvo_Treino',
      health: 100,
      kills: 0,
      deaths: 0,
      color: '#fb7185',
      x: (Math.random() * 10) - 5,
      y: 0,
      z: -((Math.random() * 8) + 4),
      yaw: 0,
      pitch: 0,
      isShooting: false
    };

    setJoinedPlayers({
      [soloId]: selfPlayer,
      [dummyPlayer.id]: dummyPlayer
    });

    setLocalHealth(100);
    stateRef.current.health = 100;
    
    // Spawn player at coordinates
    stateRef.current.x = (Math.random() * 8) - 4;
    stateRef.current.z = (Math.random() * 8) - 4;

    setInGame(true);
    setJoinError('');
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(currentRoom);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  // Main 3D Canvas Lifecycle & Render Loop
  useEffect(() => {
    if (!inGame || !canvasRef.current) return;

    const canvas = canvasRef.current;
    
    // 1. Initialize Three.js WebGL Renderer
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0f172a'); // Rich tech-dark color
    scene.fog = new THREE.FogExp2('#0f172a', 0.02);

    const camera = new THREE.PerspectiveCamera(75, canvas.clientWidth / canvas.clientHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Handle Window Resize via ResizeObserver to support split screens or canvas shifts seamlessly
    const resizeObserver = new ResizeObserver(() => {
      if (!canvas.clientWidth || !canvas.clientHeight) return;
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    });
    resizeObserver.observe(canvas);

    // 2. Add Arena Lighting
    const ambientLight = new THREE.AmbientLight('#1e293b', 1.5);
    scene.add(ambientLight);

    const skyLight = new THREE.DirectionalLight('#38bdf8', 1.8);
    skyLight.position.set(10, 40, 20);
    scene.add(skyLight);

    const floorLight = new THREE.DirectionalLight('#a78bfa', 0.8);
    floorLight.position.set(-10, 30, -20);
    scene.add(floorLight);

    // 3. Build Retro Arena
    // Floor
    const floorGeo = new THREE.PlaneGeometry(62, 62);
    const floorMat = new THREE.MeshStandardMaterial({ 
      color: '#0f172a', 
      roughness: 0.8,
      metalness: 0.1
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    scene.add(floor);

    // Grid Floor Overlay
    const gridHelper = new THREE.GridHelper(62, 31, '#475569', '#1e293b');
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);

    // Outer Boundary Walls (Closed Arena)
    const wallHeight = 4.5;
    const boundaryWallsGroup = new THREE.Group();
    const wallMat = new THREE.MeshStandardMaterial({ 
      color: '#1e293b', 
      roughness: 0.9,
      metalness: 0.3
    });

    // North Wall
    const sideWallGeoNS = new THREE.BoxGeometry(62, wallHeight, 1);
    const wallN = new THREE.Mesh(sideWallGeoNS, wallMat);
    wallN.position.set(0, wallHeight/2, -31);
    boundaryWallsGroup.add(wallN);

    // South Wall
    const wallS = new THREE.Mesh(sideWallGeoNS, wallMat);
    wallS.position.set(0, wallHeight/2, 31);
    boundaryWallsGroup.add(wallS);

    // East Wall
    const sideWallGeoEW = new THREE.BoxGeometry(1, wallHeight, 62);
    const wallE = new THREE.Mesh(sideWallGeoEW, wallMat);
    wallE.position.set(31, wallHeight/2, 0);
    boundaryWallsGroup.add(wallE);

    // West Wall
    const wallW = new THREE.Mesh(sideWallGeoEW, wallMat);
    wallW.position.set(-31, wallHeight/2, 0);
    boundaryWallsGroup.add(wallW);

    scene.add(boundaryWallsGroup);

    // 4. Scatter Tactical Obstacles (Blocky crates for shooting protection)
    const obstacles: { box: THREE.Box3; mesh: THREE.Mesh }[] = [];
    const obstacleSpecs = [
      // Central Block Structure
      { size: [6, 4, 6] as [number, number, number], pos: [0, 2, 0] as [number, number, number], color: '#334155' },
      
      // Crates scattered
      { size: [2.5, 2.5, 2.5] as [number, number, number], pos: [-12, 1.25, -12] as [number, number, number], color: '#475569' },
      { size: [3, 3, 3] as [number, number, number], pos: [12, 1.5, 12] as [number, number, number], color: '#475569' },
      { size: [2, 3.5, 2] as [number, number, number], pos: [-15, 1.75, 10] as [number, number, number], color: '#64748b' },
      { size: [4, 2, 2] as [number, number, number], pos: [10, 1.0, -14] as [number, number, number], color: '#64748b' },
      
      // Corners structures
      { size: [3, 4.5, 3] as [number, number, number], pos: [-24, 2.25, -24] as [number, number, number], color: '#1e293b' },
      { size: [3, 4.5, 3] as [number, number, number], pos: [24, 2.25, -24] as [number, number, number], color: '#1e293b' },
      { size: [3, 4.5, 3] as [number, number, number], pos: [-24, 2.25, 24] as [number, number, number], color: '#1e293b' },
      { size: [3, 4.5, 3] as [number, number, number], pos: [24, 2.25, 24] as [number, number, number], color: '#1e293b' }
    ];

    obstacleSpecs.forEach((spec) => {
      const geo = new THREE.BoxGeometry(...spec.size);
      const mat = new THREE.MeshStandardMaterial({ 
        color: spec.color,
        roughness: 0.7,
        metalness: 0.1
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { isObstacle: true };
      mesh.position.set(...spec.pos);
      scene.add(mesh);

      // Create bounding box for simple player-obstacle physics boundary resolution
      const box = new THREE.Box3().setFromObject(mesh);
      obstacles.push({ box, mesh });
    });

    // 5. Create Local Player's Weapon (First Person perspective blocky attachment)
    const localWeaponGroup = new THREE.Group();
    
    // Blocky Gun Body
    const gunBodyGeo = new THREE.BoxGeometry(0.1, 0.08, 0.35);
    const gunBodyMat = new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.5 });
    const gunBody = new THREE.Mesh(gunBodyGeo, gunBodyMat);
    gunBody.position.set(0, 0, 0);
    localWeaponGroup.add(gunBody);

    // Neon Barrel Light Strip (Futuristic retro aesthetic)
    const gunNeonGeo = new THREE.BoxGeometry(0.11, 0.02, 0.15);
    const gunNeonMat = new THREE.MeshBasicMaterial({ color: '#06b6d4' });
    const gunNeon = new THREE.Mesh(gunNeonGeo, gunNeonMat);
    gunNeon.position.set(0, 0.02, -0.05);
    localWeaponGroup.add(gunNeon);

    // Assemble Gun relative offsets
    localWeaponGroup.position.set(0.18, -0.22, -0.38); // front & right side of view
    camera.add(localWeaponGroup);
    scene.add(camera);

    // Initial positioning from state (which is randomized by server on launch)
    camera.position.set(stateRef.current.x, stateRef.current.y, stateRef.current.z);

    // 6. Handle Remote Players 3D Avatar Rendering Maps
    const remotePlayersMeshes: Record<string, {
      group: THREE.Group;
      head: THREE.Mesh;
      body: THREE.Mesh;
      lasers: THREE.Line[];
      hitbox: THREE.Mesh; // Invisible simplified direct bbox mesh to cast rays accurately
    }> = {};

    const createRemotePlayerMesh = (p: PlayerState) => {
      const g = new THREE.Group();
      
      // Avatar Color theme
      const skinColor = p.color || '#fb923c';
      const clothesColor = '#3b82f6';

      // Neck / Head Cube
      const headGeo = new THREE.BoxGeometry(0.48, 0.48, 0.48);
      const headMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.6 });
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.y = 1.05; // Relative to local player group origin
      g.add(head);

      // Tech Helmet Visor (So direction of remote visual rotation is clear)
      const visorGeo = new THREE.BoxGeometry(0.52, 0.12, 0.32);
      const visorMat = new THREE.MeshBasicMaterial({ color: '#f43f5e' }); // glowing neon pink visor
      const visor = new THREE.Mesh(visorGeo, visorMat);
      visor.position.set(0, 0.08, -0.15); // positioned front
      head.add(visor);

      // Torso Block
      const torsoGeo = new THREE.BoxGeometry(0.66, 0.88, 0.32);
      const torsoMat = new THREE.MeshStandardMaterial({ color: clothesColor, roughness: 0.8 });
      const torso = new THREE.Mesh(torsoGeo, torsoMat);
      torso.position.y = 0.38;
      g.add(torso);

      // Left Arm
      const leftArmGeo = new THREE.BoxGeometry(0.18, 0.72, 0.18);
      const armMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.7 });
      const leftArm = new THREE.Mesh(leftArmGeo, armMat);
      leftArm.position.set(-0.43, 0.38, 0);
      g.add(leftArm);

      // Right Arm (Forward punching visual) holding Weapon Block
      const rightArmGeo = new THREE.BoxGeometry(0.18, 0.72, 0.18);
      const rightArm = new THREE.Mesh(rightArmGeo, armMat);
      rightArm.position.set(0.43, 0.38, -0.15);
      rightArm.rotation.x = -Math.PI / 3; // pointing arm forward
      g.add(rightArm);

      // Block Pistol
      const repPistolGeo = new THREE.BoxGeometry(0.08, 0.08, 0.24);
      const repPistolMat = new THREE.MeshStandardMaterial({ color: '#1e293b' });
      const repPistol = new THREE.Mesh(repPistolGeo, repPistolMat);
      repPistol.position.set(0, -0.28, -0.15);
      rightArm.add(repPistol);

      // Left Leg
      const legMat = new THREE.MeshStandardMaterial({ color: '#1e293b', roughness: 0.9 });
      const leftLegGeo = new THREE.BoxGeometry(0.2, 0.55, 0.2);
      const leftLeg = new THREE.Mesh(leftLegGeo, legMat);
      leftLeg.position.set(-0.2, -0.32, 0);
      g.add(leftLeg);

      // Right Leg
      const rightLegGeo = new THREE.BoxGeometry(0.2, 0.55, 0.2);
      const rightLeg = new THREE.Mesh(rightLegGeo, legMat);
      rightLeg.position.set(0.2, -0.32, 0);
      g.add(rightLeg);

      // Invisible Capsule hitbox for simplified rapid raycast collision checks mapping
      const hitboxGeo = new THREE.BoxGeometry(0.85, 2.0, 0.85);
      const hitboxMat = new THREE.MeshBasicMaterial({ 
        visible: false // Only active for math boundary calculations
      });
      const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
      hitbox.position.y = 0.5;
      hitbox.name = `remote-player-hitbox:${p.id}`; // marker tag to map ray hit
      g.add(hitbox);

      scene.add(g);
      return { group: g, head, body: torso, lasers: [], hitbox };
    };

    // Keep mesh structure updated in real-time as state elements shift
    const syncRemotePlayers = () => {
      const activePlayers = joinedPlayersRef.current;
      const myId = socketRef.current?.id || localPlayerId;

      // Check for removed players
      Object.keys(remotePlayersMeshes).forEach((id) => {
        if (!activePlayers[id] || id === myId) {
          scene.remove(remotePlayersMeshes[id].group);
          delete remotePlayersMeshes[id];
        }
      });

      // Spawn or update active players
      Object.keys(activePlayers).forEach((id) => {
        if (id === myId) return; // skip self

        const p = activePlayers[id];
        if (p.health <= 0) {
          // If dead, temporarily hide group or lower to ground, otherwise render
          if (remotePlayersMeshes[id]) {
            remotePlayersMeshes[id].group.visible = false;
          }
          return;
        }

        if (!remotePlayersMeshes[id]) {
          remotePlayersMeshes[id] = createRemotePlayerMesh(p);
        }

        const rm = remotePlayersMeshes[id];
        rm.group.visible = true;

        // Visual lerp updates or rapid positioning transfers
        rm.group.position.set(p.x, p.y, p.z);
        rm.group.rotation.y = p.yaw;
        rm.head.rotation.x = p.pitch;

        // Show shooting visuals if active
        const bodyMat = rm.body.material as THREE.MeshStandardMaterial;
        if (p.isShooting) {
          bodyMat.color.set('#f43f5e'); // turns deep red on firing
        } else {
          bodyMat.color.set('#3b82f6');
        }
      });
    };

    // Listen to Shoot triggers specifically to emit flash vectors
    const handleRemoteVisualShoot = (data: { id: string }) => {
      const rm = remotePlayersMeshes[data.id];
      if (!rm) return;

      // Create visual retro neon trajectory laser beam tracing the gun facing
      const laserGeo = new THREE.BufferGeometry();
      const gunTipWorldPos = new THREE.Vector3();
      rm.group.getWorldPosition(gunTipWorldPos);
      gunTipWorldPos.y += 0.45; // adjustment near arm height

      const endPos = new THREE.Vector3(
        gunTipWorldPos.x - Math.sin(rm.group.rotation.y) * 45,
        gunTipWorldPos.y + Math.sin(rm.head.rotation.x) * 45,
        gunTipWorldPos.z - Math.cos(rm.group.rotation.y) * 45
      );

      laserGeo.setFromPoints([gunTipWorldPos, endPos]);
      const laserMat = new THREE.LineBasicMaterial({ color: '#ef4444', linewidth: 2 });
      const laserLine = new THREE.Line(laserGeo, laserMat);
      scene.add(laserLine);

      // Clean up laser trace from viewport after 70 milliseconds
      setTimeout(() => {
        scene.remove(laserLine);
        laserGeo.dispose();
        laserMat.dispose();
      }, 70);
    };

    socketRef.current?.on('player:shoot', handleRemoteVisualShoot);

    // 7. Input state handling variables
    const keysPressed = new Set<string>();
    
    const handleKeyDown = (e: KeyboardEvent) => {
      keysPressed.add(e.code);

      // Tab scoreboard trigger
      if (e.code === 'Tab') {
        e.preventDefault();
        setIsScoreboardOpen(true);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed.delete(e.code);
      if (e.code === 'Tab') {
        setIsScoreboardOpen(false);
      }
    };

    // Handle Pointer Looking modifications
    const handleMouseMove = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;

      const sensitivity = 0.0022;
      stateRef.current.yaw -= e.movementX * sensitivity;
      stateRef.current.pitch -= e.movementY * sensitivity;

      // Clamp pitch to avoid neck break inversion
      stateRef.current.pitch = Math.max(-Math.PI / 2.1, Math.min(Math.PI / 2.1, stateRef.current.pitch));
    };

    // Track pointer lock triggers directly
    const onPointerLockChange = () => {
      setPointerLocked(document.pointerLockElement === canvas);
    };

    canvas.addEventListener('click', () => {
      canvas.requestPointerLock?.();
    });

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    // Fire mechanics on Click
    const handleMouseClick = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      if (stateRef.current.health <= 0) return; // Cant shoot if dead

      // Play local sound
      playGunshotSound();

      // Trigger server visual flash
      socketRef.current?.emit('player:shoot');

      // Local recoil weapon motion feedback
      localWeaponGroup.position.z += 0.12; // kickback recoil displacement

      // Gun muzzle flash light
      const flashLight = new THREE.PointLight('#fbbf24', 5, 4);
      flashLight.position.set(0.18, -0.22, -0.55);
      camera.add(flashLight);
      setTimeout(() => {
        camera.remove(flashLight);
      }, 50);

      // Hit Verification via central Raycast
      const raycaster = new THREE.Raycaster();
      // Center coordinates represent the exact crosshair target pixel
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

      // Collect all checkable hitboxes (excluding self)
      const targetHitboxes = Object.values(remotePlayersMeshes).map(item => item.hitbox);
      const arenaObstaclesMesh = obstacles.map(item => item.mesh);

      // Intersect both players and walls/pillars to block double hits behind structures
      const intersects = raycaster.intersectObjects([...targetHitboxes, ...arenaObstaclesMesh]);

      if (intersects.length > 0) {
        // Evaluate the absolute nearest entity hit
        const hitObj = intersects[0].object;

        if (hitObj.name && hitObj.name.startsWith('remote-player-hitbox:')) {
          const matchedVictimId = hitObj.name.split(':')[1];
          
          if (socketRef.current && socketRef.current.connected) {
            // Register Hit on Target via server!
            socketRef.current?.emit('player:hit', {
              victimId: matchedVictimId,
              damage: 25 // 4 hits to defeat
            });
          } else {
            // Local sandbox mode damage simulation
            setJoinedPlayers(prev => {
              if (!prev[matchedVictimId]) return prev;
              const victim = { ...prev[matchedVictimId] };
              victim.health = Math.max(0, victim.health - 25);
              
              if (victim.health <= 0) {
                // Spawn kill feed message
                const newFeed: KillFeedEntry = {
                  id: Math.random().toString(),
                  attacker: playerName,
                  victim: victim.name,
                  timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                };
                setKillFeed(feed => [newFeed, ...feed].slice(0, 5));
                playEliminationSound();
                setTimeout(() => {
                  setKillFeed(feed => feed.filter(f => f.id !== newFeed.id));
                }, 4500);

                // Update score
                setTimeout(() => {
                  setJoinedPlayers(next => {
                    const copy = { ...next };
                    if (copy['solo']) copy['solo'].kills += 1;
                    return copy;
                  });
                }, 10);

                // Respawn target dummy in 1 second
                setTimeout(() => {
                  setJoinedPlayers(next => {
                    if (!next[matchedVictimId]) return next;
                    return {
                      ...next,
                      [matchedVictimId]: {
                        ...next[matchedVictimId],
                        health: 100,
                        x: (Math.random() * 20) - 10,
                        z: -((Math.random() * 15) + 5)
                      }
                    };
                  });
                }, 1000);
              }

              return {
                ...prev,
                [matchedVictimId]: victim
              };
            });
          }

          // Play audio and show hitmarker visual
          playHitSound();
          setIsHitmarkerActive(true);
          setTimeout(() => setIsHitmarkerActive(false), 140);
        }
      }
    };

    window.addEventListener('mousedown', handleMouseClick);

    // 8. Core Animation Physics and Networking Update loops
    let lastTime = performance.now();
    let syncThrottleCounter = 0;

    const gameLoop = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1); // caps maximum delta frame to prevent clipping on freeze
      lastTime = now;

      if (stateRef.current.health > 0) {
        // Player locomotion physics (Keyboard reading WASD status)
        const moveVector = new THREE.Vector3();
        
        if (keysPressed.has('KeyW') || keysPressed.has('ArrowUp')) moveVector.z -= 1.0;
        if (keysPressed.has('KeyS') || keysPressed.has('ArrowDown')) moveVector.z += 1.0;
        if (keysPressed.has('KeyA') || keysPressed.has('ArrowLeft')) moveVector.x -= 1.0;
        if (keysPressed.has('KeyD') || keysPressed.has('ArrowRight')) moveVector.x += 1.0;

        moveVector.normalize();

        // Account for horizontal camera yaw direction
        const currentYaw = stateRef.current.yaw;
        const forward = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), currentYaw).normalize();
        const right = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), currentYaw).normalize();

        const translationForce = new THREE.Vector3();
        translationForce.addScaledVector(forward, -moveVector.z);
        translationForce.addScaledVector(right, moveVector.x);
        translationForce.normalize();

        // Speed definitions
        const speed = 7.5;
        const finalDisplacement = translationForce.multiplyScalar(speed * dt);

        // Apply moving displacement to camera coordinate
        const nextX = camera.position.x + finalDisplacement.x;
        const nextZ = camera.position.z + finalDisplacement.z;

        // Boundary Clamp inside Arena (floor is 62x62 boundary walls at 31)
        const arenaLimit = 29.8;
        let clampedX = Math.max(-arenaLimit, Math.min(arenaLimit, nextX));
        let clampedZ = Math.max(-arenaLimit, Math.min(arenaLimit, nextZ));

        // Simple Obstacle Collision Resolution Checks
        const playerRadius = 0.5;
        const futureBox = new THREE.Box3(
          new THREE.Vector3(clampedX - playerRadius, camera.position.y - 1.6, clampedZ - playerRadius),
          new THREE.Vector3(clampedX + playerRadius, camera.position.y + 0.4, clampedZ + playerRadius)
        );

        obstacles.forEach(({ box }) => {
          if (futureBox.intersectsBox(box)) {
            // Solve collision by pushing back players on the intersecting axis
            const overlapX = Math.min(futureBox.max.x - box.min.x, box.max.x - futureBox.min.x);
            const overlapZ = Math.min(futureBox.max.z - box.min.z, box.max.z - futureBox.min.z);

            if (overlapX < overlapZ) {
              if (camera.position.x < box.min.x) clampedX -= overlapX;
              else clampedX += overlapX;
            } else {
              if (camera.position.z < box.min.z) clampedZ -= overlapZ;
              else clampedZ += overlapZ;
            }
          }
        });

        camera.position.x = clampedX;
        camera.position.z = clampedZ;

        // Leaping Jumping Mechanics and downward gravity
        const gravity = -26.0;
        stateRef.current.vy += gravity * dt;
        camera.position.y += stateRef.current.vy * dt;

        // Standing Surface lock height (y = 1.6 is default standing camera eye level)
        const standingY = 1.6;
        if (camera.position.y <= standingY) {
          camera.position.y = standingY;
          stateRef.current.vy = 0;
          stateRef.current.isGrounded = true;

          // Leap Trigger
          if (keysPressed.has('Space')) {
            stateRef.current.vy = 8.5; // push vertical force
            stateRef.current.isGrounded = false;
          }
        }

        // Apply camera rotational yaw/pitch vectors to 3D orientation matrices
        camera.rotation.order = 'YXZ';
        camera.rotation.y = stateRef.current.yaw;
        camera.rotation.x = stateRef.current.pitch;

        // Recover muzzle local weapon recoil slide back to original orientation
        localWeaponGroup.position.z = THREE.MathUtils.lerp(localWeaponGroup.position.z, -0.38, 12 * dt);
      } else {
        // If local player is dead, pan camera state looking up at sky or lower to ground
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.4, 5 * dt);
        camera.rotation.x = THREE.MathUtils.lerp(camera.rotation.x, -Math.PI / 4, 3 * dt);
      }

      // Update stateRef container variables
      stateRef.current.x = camera.position.x;
      stateRef.current.y = camera.position.y;
      stateRef.current.z = camera.position.z;
      stateRef.current.isShooting = keysPressed.has('KeyF'); // auxiliary shooting flag if mouse click fails

      // Synchronize player position with the server 30 times a second (saving container network band)
      syncThrottleCounter++;
      if (syncThrottleCounter >= 2) {
        syncThrottleCounter = 0;
        socketRef.current?.emit('player:sync', {
          x: stateRef.current.x,
          // Subtract height offset so player models appear standing nicely flat on top of the grid helper
          y: stateRef.current.y - 1.6, 
          z: stateRef.current.z,
          yaw: stateRef.current.yaw,
          pitch: stateRef.current.pitch,
          isShooting: false
        });
      }

      // Synchronize remote player block representation states
      syncRemotePlayers();

      // Fire Render Frame
      renderer.render(scene, camera);
      requestAnimationFrame(gameLoop);
    };

    const animFrameId = requestAnimationFrame(gameLoop);

    // Clean up Three.js objects of the room on component shift/unmount
    return () => {
      cancelAnimationFrame(animFrameId);
      resizeObserver.disconnect();
      socketRef.current?.off('player:shoot', handleRemoteVisualShoot);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mousedown', handleMouseClick);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      
      // Memory deallocations
      floorGeo.dispose();
      floorMat.dispose();
      sideWallGeoNS.dispose();
      sideWallGeoEW.dispose();
      wallMat.dispose();
      gunBodyGeo.dispose();
      gunBodyMat.dispose();
      gunNeonGeo.dispose();
      gunNeonMat.dispose();
      renderer.dispose();
    };
  }, [inGame]);

  return (
    <div id="game-workspace-wrapper" className="min-h-screen bg-slate-900 text-slate-100 font-sans flex flex-col relative select-none">
      
      {/* 1. LOBBY SCREEN OVERLAY */}
      {!inGame ? (
        <div id="lobby-panel" className="flex-1 flex flex-col items-center justify-center p-6 bg-radial from-slate-900 to-slate-950">
          
          <div id="lobby-header-badge" className="mb-6 flex items-center gap-2 bg-slate-800/80 px-4 py-2 rounded-full border border-slate-700 shadow-md">
            <Sword className="w-5 h-5 text-red-500 animate-pulse" />
            <span className="text-xs tracking-widest uppercase font-black text-rose-400">FPS Retro-LAN Arena</span>
          </div>

          <div id="lobby-card" className="max-w-md w-full bg-slate-800/60 backdrop-blur-md rounded-2xl border border-slate-700/80 p-6 sm:p-8 shadow-2xl relative overflow-hidden">
            <div id="lobby-card-gradient" className="absolute -right-16 -top-16 w-44 h-44 rounded-full bg-rose-500/10 blur-3xl" />
            <div id="lobby-card-gradient2" className="absolute -left-16 -bottom-16 w-44 h-44 rounded-full bg-blue-500/10 blur-3xl" />

            <div id="lobby-intro-title-group" className="text-center mb-6">
              <h2 className="text-2xl font-black text-white tracking-tight">LAN MULTIPLAYER</h2>
              <p className="text-slate-400 text-xs mt-1">Crie ou entre em salas privadas instantâneas sem contas</p>
            </div>

            {/* ERROR NOTIFICATION PANEL */}
            {joinError && (
              <div id="lobby-error-alert" className="mb-4 bg-red-950/50 border border-red-500/40 rounded-xl p-3 text-xs text-red-300 font-medium flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-ping" />
                <span>{joinError}</span>
              </div>
            )}

            {/* FIELD: PLAYER NAME */}
            <div id="name-field-group" className="space-y-2 mb-4">
              <label className="text-xs font-bold text-slate-400 tracking-wide flex items-center gap-1.5 uppercase">
                <User className="w-3.5 h-3.5 text-blue-400" /> Seu Nome / Nickname
              </label>
              <input
                id="input-player-name"
                type="text"
                value={playerName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Insira seu apelido..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm text-slate-100 placeholder-slate-500 font-semibold focus:outline-none focus:border-blue-500 transition-all shadow-inner"
              />
            </div>

            {/* FIELD: SERVER CONFIGURATION (Highly useful for custom deployments e.g Vercel/Localhost -> Cloud Run) */}
            <div id="server-config-group" className="space-y-2 mb-5">
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setShowServerConfig(!showServerConfig)}
                  className="text-[11px] text-slate-400 hover:text-slate-300 font-bold flex items-center gap-1.5 bg-slate-900/45 px-3 py-2 rounded-xl border border-slate-700/50 hover:border-slate-600 transition-all cursor-pointer select-none"
                >
                  <Tv className="w-3.5 h-3.5 text-indigo-400" />
                  {showServerConfig ? 'Ocultar Configurações de Servidor' : 'Mostrar Configurações de Servidor'}
                </button>

                {/* Live connection status badge */}
                <div className="flex items-center gap-1.5 bg-slate-900/40 px-2.5 py-1.5 rounded-lg border border-slate-800 text-[10px] uppercase tracking-wider font-semibold">
                  <span className={`w-2 h-2 rounded-full ${
                    connectionStatus === 'connected' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]' :
                    connectionStatus === 'connecting' ? 'bg-amber-500 animate-pulse' :
                    'bg-rose-500 animate-pulse'
                  }`} />
                  <span className={
                    connectionStatus === 'connected' ? 'text-emerald-400 font-bold' :
                    connectionStatus === 'connecting' ? 'text-amber-400 font-bold' :
                    'text-rose-400 font-bold'
                  }>
                    {connectionStatus === 'connected' ? 'ONLINE' :
                     connectionStatus === 'connecting' ? 'CONECTANDO...' :
                     'ERRO CONEXÃO'}
                  </span>
                </div>
              </div>

              {showServerConfig && (
                <div id="server-config-fields" className="bg-slate-900/60 border border-slate-800 p-4 rounded-xl space-y-2.5 animate-fade-in text-left">
                  <label className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">
                    Endereço do Servidor (Socket.IO)
                  </label>
                  <input
                    id="input-server-url"
                    type="text"
                    value={serverUrl}
                    onChange={(e) => {
                      const val = e.target.value;
                      setServerUrl(val);
                      localStorage.setItem('blocky_fps_server_url', val);
                    }}
                    placeholder="Ex: https://meu-servidor-fps.run.app"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-indigo-300 font-mono focus:outline-none focus:border-indigo-500 transition-all"
                  />
                  <p className="text-[10px] text-slate-500 leading-relaxed font-semibold">
                    Se estiver jogando em um servidor externo (como Vercel), insira aqui a URL do seu servidor do AI Studio (Cloud Run) para sincronizar. Por padrão, conecta na origem da página (<code className="text-slate-400">{window.location.origin}</code>).
                  </p>
                </div>
              )}
            </div>

            <div id="lobby-divider" className="border-t border-slate-700/60 my-5 relative">
              <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 bg-slate-800 px-3 text-[10px] font-black text-slate-500 tracking-widest">SALA DE REDE</span>
            </div>

            {/* ACTION DIRECTORS */}
            <div id="lobby-actions" className="space-y-4">
              {/* Box: CREATE ROOM */}
              <button
                id="btn-create-lobby"
                onClick={createRoom}
                className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 px-5 py-3.5 rounded-xl font-bold text-sm tracking-wide text-white transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 hover:shadow-blue-500/10"
              >
                <Zap className="w-4 h-4 text-amber-300" /> Criar Nova Sala (Gerar Token)
              </button>

              <div id="lobby-mini-spacer" className="text-center text-slate-500 text-xs py-0.5 font-bold">OU entrar por código</div>

              {/* BOX: JOIN ROOM */}
              <div id="join-form-wrapper" className="flex gap-2 animate-fade-in">
                <div className="relative flex-1">
                  <Hash className="absolute left-3.5 top-3.5 w-4 h-4 text-slate-500" />
                  <input
                    id="input-room-token"
                    type="text"
                    maxLength={5}
                    value={roomCodeInput}
                    onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase().trim())}
                    placeholder="TOKEN"
                    className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-9 pr-4 py-3 text-sm text-white font-mono placeholder-slate-600 focus:outline-none focus:border-rose-500 transition-all tracking-wider"
                  />
                </div>
                <button
                  id="btn-join-lobby"
                  onClick={joinRoom}
                  className="bg-slate-700 hover:bg-slate-600 border border-slate-600 hover:border-slate-500 text-white font-bold text-sm px-6 rounded-xl transition-all active:scale-95 flex items-center justify-center"
                >
                  Entrar
                </button>
              </div>

              {/* OFFLINE SANDBOX BACKUP - Perfect for Vercel/External environments */}
              <div id="lobby-solo-divider" className="border-t border-slate-700/40 pt-1.5 mt-2">
                <button
                  id="btn-practice-offline"
                  type="button"
                  onClick={startPracticeMode}
                  className="w-full bg-slate-900/65 hover:bg-slate-900/90 text-slate-300 hover:text-white border border-slate-700/60 hover:border-slate-500/80 px-5 py-3 rounded-xl font-bold text-xs uppercase tracking-wider transition-all shadow-md active:scale-95 flex items-center justify-center gap-2 cursor-pointer"
                >
                  <Target className="w-4 h-4 text-rose-500 animate-pulse" /> Jogar Offline (Modo Prática / Alvo)
                </button>
              </div>
            </div>

            {/* CONTROLS INSTRUCTIONS DECK */}
            <div id="lobby-controls-help" className="mt-6 bg-slate-900/40 border border-slate-700/50 rounded-xl p-4">
              <h3 className="text-xs font-bold text-slate-300 flex items-center gap-1.5 uppercase mb-2">
                <Keyboard className="w-3.5 h-3.5 text-rose-400" /> Comandos de Teclado e Mouse:
              </h3>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] text-slate-400 font-medium">
                <div className="flex items-center gap-1.5">
                  <span className="bg-slate-800 text-slate-300 border border-slate-700 px-1 py-0.5 rounded font-mono text-[9px] font-bold">W,A,S,D</span>
                  <span>Andar Arena</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="bg-slate-800 text-slate-300 border border-slate-700 px-1 py-0.5 rounded font-mono text-[9px] font-bold">MOUSE</span>
                  <span>Olhar ao redor</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="bg-slate-800 text-slate-300 border border-slate-700 px-1.5 py-0.5 rounded font-mono text-[9px] font-bold">ESPAÇO</span>
                  <span>Pular</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="bg-slate-800 text-slate-300 border border-slate-700 px-1.5 py-0.5 rounded font-mono text-[9px] font-bold">CLIQUE ESQ.</span>
                  <span>Atirar Arma</span>
                </div>
              </div>
            </div>

          </div>

          <p id="lobby-credits-footer" className="text-[10px] text-slate-600 font-bold mt-8 tracking-widest uppercase">
            FPS Multipayer • Servidor local integrado • Tráfego P2P ultra-leve
          </p>
        </div>
      ) : (
        
        // 2. ACTIVE GAMEPLAY LAYER
        <div id="gameplay-hud-container" className="flex-1 relative flex flex-col h-screen overflow-hidden">
          
          {/* THREE.JS DYNAMIC CANVAS MOUNT */}
          <canvas 
            id="three-game-canvas" 
            ref={canvasRef} 
            className="w-full flex-1 block outline-none cursor-crosshair h-full" 
          />

          {/* VISUAL DAMAGE BLOOD FLASH INDICATOR */}
          {localHealthFlashAlert && (
            <div 
              id="hud-blood-flash" 
              className="absolute inset-0 border-[20px] sm:border-[40px] border-red-600/35 pointer-events-none z-40 animate-pulse transition-all duration-75" 
            />
          )}

          {/* RETRO POINTER LOCK ALERT SCREEN COVERS (WHEN UNCLICKED) */}
          {!pointerLocked && (
            <div 
              id="pointer-lock-overlay" 
              className="absolute inset-0 bg-slate-950/85 flex flex-col items-center justify-center p-6 text-center z-30 transition-all backdrop-blur-sm cursor-pointer"
              onClick={() => {
                canvasRef.current?.requestPointerLock?.();
              }}
            >
              <div id="pl-wrapper" className="max-w-sm bg-slate-900 border border-slate-700 rounded-2xl p-6 shadow-2xl flex flex-col items-center">
                <CircleDot className="w-12 h-12 text-blue-400 animate-ping mb-4" />
                <h3 className="text-lg font-black text-white">CLIQUE PARA JOGAR</h3>
                <p className="text-slate-400 text-xs mt-2 leading-relaxed">
                  Para habilitar o controle de câmera de primeira pessoa e a mira do mouse, o navegador precisa obter captura de cursor.
                </p>
                <button 
                  id="btn-lock-pointer"
                  className="mt-5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 px-6 py-2.5 rounded-xl text-xs font-black text-white tracking-widest uppercase shadow-md active:scale-95"
                >
                  Capturar Mouse
                </button>
              </div>
            </div>
          )}

          {/* INGAME SPECTACULAR HEADS-UP DISPLAY (HUD) OVERLAYS */}
          
          {/* HUD CORNER LEFT: HEALTH METER */}
          <div id="hud-stats-left" className="absolute bottom-6 left-6 bg-slate-950/75 border border-slate-800/80 p-4 rounded-2xl shadow-xl flex items-center gap-3.5 min-w-[150px] sm:min-w-[190px]">
            <div id="health-icon" className={`p-2.5 rounded-xl ${localHealth > 30 ? 'bg-emerald-500/10' : 'bg-red-500/10'} shrink-0`}>
              <Heart className={`w-6 h-6 ${localHealth > 30 ? 'text-emerald-400' : 'text-red-400 animate-bounce'}`} />
            </div>
            <div className="flex-1">
              <div className="flex justify-between items-end mb-1">
                <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wide">PONTOS DE VIDA</span>
                <span className={`text-xl font-black font-mono leading-none ${localHealth > 30 ? 'text-white' : 'text-red-400'}`}>
                  {localHealth}
                </span>
              </div>
              {/* Animated health progress gauge */}
              <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                <div 
                  id="hud-health-bar"
                  style={{ width: `${Math.max(0, localHealth)}%` }}
                  className={`h-full rounded-full transition-all duration-300 ${localHealth > 50 ? 'bg-emerald-500' : localHealth > 25 ? 'bg-amber-500' : 'bg-red-500'}`} 
                />
              </div>
            </div>
          </div>

          {/* HUD CORNER RIGHT: ACTIVE ROOM DETAILS */}
          <div id="hud-stats-right" className="absolute top-6 right-6 flex flex-col gap-2 bg-slate-950/75 border border-slate-800/80 p-4 rounded-2xl shadow-xl min-w-[200px]">
            <div id="room-header-badge" className="flex items-center justify-between border-b border-slate-800/60 pb-2 mb-1.5">
              <span className="text-[10px] text-slate-400 font-black tracking-widest uppercase">CONEXÃO LAN</span>
              <button 
                id="btn-hud-leave"
                onClick={leaveGame}
                className="text-[10px] text-rose-400 hover:text-rose-300 font-bold flex items-center gap-1 transition-colors"
                title="Sair do Lobby"
              >
                <LogOut className="w-3 h-3" /> SAIR
              </button>
            </div>

            {/* Readout: Token Code */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-400 font-bold flex items-center gap-1">Token Sala:</span>
              <div className="flex items-center gap-1.5">
                <span className="font-mono font-black text-rose-400 bg-rose-950/45 border border-rose-500/20 px-2 py-0.5 rounded text-xs tracking-wider">
                  {currentRoom}
                </span>
                <button
                  id="btn-hud-copy-token"
                  onClick={copyRoomCode}
                  className="text-slate-400 hover:text-white transition-colors"
                  title="Copiar Código"
                >
                  {copiedCode ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>

            {/* Readout: Connected Count */}
            <div className="flex items-center justify-between text-xs mt-1">
              <span className="text-slate-400 font-bold flex items-center gap-1">Conectados:</span>
              <span className="font-black text-blue-400 flex items-center gap-1 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded text-xs font-mono">
                <Users className="w-3 h-3 text-blue-400" />
                {Object.keys(joinedPlayers).length} / 12
              </span>
            </div>
          </div>

          {/* DYNAMIC RETRO SPECTATOR KILL FEED */}
          <div id="hud-kill-feed" className="absolute top-6 left-6 max-w-sm pointer-events-none space-y-1.5">
            {killFeed.map((feed) => (
              <div 
                id={`kill-feed-${feed.id}`}
                key={feed.id} 
                className="bg-slate-950/70 border-l-2 border-red-500/80 py-1.5 px-3 rounded-r-lg text-xs font-bold font-mono text-slate-100 flex items-center gap-2 animate-slide-in backdrop-blur-sm"
              >
                <span className="text-rose-400">{feed.attacker}</span> 
                <span className="text-slate-500 lowercase font-medium text-[10px]">eliminated</span> 
                <span className="text-slate-200">{feed.victim}</span>
              </div>
            ))}
          </div>

          {/* CORE ELEMENT: MIRACULOUS RETRO CENTRAL CROSSHAIR */}
          <div id="hud-crosshair-wrapper" className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {/* Simple dot-crosshair layout with responsive hitmarker indicator */}
            <div className="relative flex items-center justify-center">
              {/* Standard Center Target pixel dot */}
              <div className="w-2 h-2 bg-rose-500 rounded-full border border-white/40 shadow-sm" />
              
              {/* Outer aiming lines */}
              <div className="absolute w-5 h-0.5 bg-rose-500/60 -left-6" />
              <div className="absolute w-5 h-0.5 bg-rose-500/60 -right-6" />
              <div className="absolute h-5 w-0.5 bg-rose-500/60 -top-6" />
              <div className="absolute h-5 w-0.5 bg-rose-500/60 -bottom-6" />

              {/* Dynamic glowing red 'X' hitmaker */}
              {isHitmarkerActive && (
                <div id="hitmarker-visual" className="absolute w-8 h-8 flex items-center justify-center">
                  <div className="absolute w-4 h-0.5 bg-red-400 rotate-45 transform origin-center translate-x-2 -translate-y-2" />
                  <div className="absolute w-4 h-0.5 bg-red-400 -rotate-45 transform origin-center -translate-x-2 -translate-y-2" />
                  <div className="absolute w-4 h-0.5 bg-red-400 -rotate-45 transform origin-center translate-x-2 translate-y-2" />
                  <div className="absolute w-4 h-0.5 bg-red-400 rotate-45 transform origin-center -translate-x-2 translate-y-2" />
                </div>
              )}
            </div>
          </div>

          {/* DYNAMIC FLOATING NAME TAGS & STATS ABOVE THREED PLAYERS */}
          {/* We translate remote coordinates to screen coordinates and map cleanly here */}
          <div id="floating-names-deck" className="absolute inset-0 pointer-events-none overflow-hidden z-10">
            {Object.values(joinedPlayers).map((p: any) => {
              // Only render tags for other players who are actively alive
              if (p.id === localPlayerId || p.health <= 0) return null;
              
              return (
                <div 
                  id={`remote-tag-${p.id}`}
                  key={p.id}
                  className="hidden absolute -translate-x-1/2 -translate-y-full flex flex-col items-center"
                >
                  <div className="bg-slate-950/80 border border-slate-700/60 py-1 px-2.5 rounded-lg text-[10px] text-white font-bold flex flex-col items-center gap-1 shadow-md">
                    <span className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: p.color }} />
                      {p.name}
                    </span>
                    {/* Small visual hp readout */}
                    <div className="w-16 h-1 bg-slate-800 rounded-full overflow-hidden">
                      <div className="h-full bg-red-500 rounded-full" style={{ width: `${p.health}%` }} />
                    </div>
                  </div>
                  {/* Little pointing arrow */}
                  <div className="w-1.5 h-1.5 bg-slate-900 border-r border-b border-slate-700/60 transform rotate-45 -mt-1" />
                </div>
              );
            })}
          </div>

          {/* SCOREBOARD OVERLAY (HOLD TAB TO LAUNCH) */}
          {isScoreboardOpen && (
            <div id="hud-scoreboard-overlay" className="absolute inset-0 bg-slate-950/75 backdrop-blur-xs flex items-center justify-center p-6 z-20">
              <div className="max-w-xl w-full bg-slate-900 border border-slate-800 p-6 rounded-2xl shadow-2xl">
                
                <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
                  <div className="flex items-center gap-2">
                    <Award className="w-5 h-5 text-indigo-400" />
                    <h3 className="text-base font-black text-white tracking-wider uppercase">Placar da Partida • Arena LAN</h3>
                  </div>
                  <span className="text-xs text-rose-400 font-mono font-bold bg-rose-950/45 px-2 py-0.5 rounded tracking-wider">{currentRoom}</span>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-slate-400 border-b border-slate-800/80 uppercase font-bold tracking-wider">
                        <th className="pb-2.5 pl-2">Jogador</th>
                        <th className="pb-2.5 text-center">Eliminações</th>
                        <th className="pb-2.5 text-center">Mortes</th>
                        <th className="pb-2.5 text-right pr-2">Cor Vetor</th>
                      </tr>
                    </thead>
                    <tbody id="scoreboard-body" className="divide-y divide-slate-800/40">
                      {Object.values(joinedPlayers)
                        .sort((a: any, b: any) => b.kills - a.kills)
                        .map((p: any) => (
                          <tr key={p.id} className={`hover:bg-slate-800/40 ${p.id === localPlayerId ? 'bg-indigo-950/20 font-black' : ''}`}>
                            <td className="py-2.5 pl-2 flex items-center gap-2">
                              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.color }} />
                              <span className="text-white">{p.name} {p.id === localPlayerId ? '(Você)' : ''}</span>
                            </td>
                            <td className="py-2.5 text-center text-teal-400 font-mono font-bold">{p.kills}</td>
                            <td className="py-2.5 text-center text-rose-400 font-mono font-medium">{p.deaths}</td>
                            <td className="py-2.5 text-right pr-2">
                              <span className="text-[10px] font-mono text-slate-500 uppercase">{p.color}</span>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-800/80 text-[10px] text-slate-400 flex justify-between">
                  <span>Solte a tecla 'TAB' para fechar e retornar ao campo de tiro</span>
                  <span>Total de combatentes: {Object.keys(joinedPlayers).length}</span>
                </div>

              </div>
            </div>
          )}

          {/* DYNAMIC TIP LABEL */}
          <div id="hud-spectator-tip" className="absolute bottom-6 right-6 pointer-events-none bg-slate-950/60 backdrop-blur-xs px-3 py-1.5 rounded-xl border border-slate-800 text-[10px] text-slate-400 font-bold tracking-wide">
            Segure SEG_TECLA <span className="text-white uppercase">TAB</span> para consultar o Placar
          </div>

        </div>
      )}
    </div>
  );
}
