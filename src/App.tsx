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
  VolumeX,
  Sliders,
  RefreshCw,
  Sword,
  Target
} from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import * as THREE from 'three';
import { PlayerState, KillFeedEntry, MatchState } from './types';

let globalMuted = false;

// Procedural audio generation using standard Web Audio API (extremely robust & visual feedback)
const playGunshotSound = () => {
  if (globalMuted) return;
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
  if (globalMuted) return;
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
  if (globalMuted) return;
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

const safeRequestPointerLock = (element: HTMLCanvasElement | null) => {
  if (!element) return;
  try {
    const promise = element.requestPointerLock() as any;
    if (promise && typeof promise.catch === 'function') {
      promise.catch((err: any) => {
        console.warn("Pointer lock request handled safely (preventing uncaught exception):", err);
      });
    }
  } catch (err) {
    console.warn("Pointer lock call caught synchronous exception:", err);
  }
};

const defaultMatchState: MatchState = {
  phase: 'waiting',
  countdown: null,
  blueScore: 0,
  redScore: 0,
  roundNumber: 0,
  message: 'Aguardando segundo jogador',
  activePlayerIds: []
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
  const [matchState, setMatchState] = useState<MatchState>(defaultMatchState);
  const [roundGoVisible, setRoundGoVisible] = useState(false);
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

  const [mouseSensitivity, setMouseSensitivity] = useState(2.2);
  const [soundMutedState, setSoundMutedState] = useState(false);
  const [botDifficulty, setBotDifficulty] = useState<'easy' | 'medium' | 'hardcore'>('medium');
  const [selectedSkin, setSelectedSkin] = useState<'classic' | 'gold' | 'arctic' | 'rust'>('classic');

  const sensitivityRef = useRef(0.0022);
  const botDifficultyRef = useRef<'easy' | 'medium' | 'hardcore'>('medium');
  const selectedSkinRef = useRef<'classic' | 'gold' | 'arctic' | 'rust'>('classic');

  // Sync mouse sensitivity state to ref
  useEffect(() => {
    sensitivityRef.current = mouseSensitivity * 0.001;
  }, [mouseSensitivity]);

  // Sync bot difficulty state to ref
  useEffect(() => {
    botDifficultyRef.current = botDifficulty;
  }, [botDifficulty]);

  // Sync weapons skin state to ref
  useEffect(() => {
    selectedSkinRef.current = selectedSkin;
  }, [selectedSkin]);

  // Sync mute state to globalMuted
  useEffect(() => {
    globalMuted = soundMutedState;
  }, [soundMutedState]);

  // References to communicate with Three.js loops
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<Socket | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);

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

  const matchStateRef = useRef<MatchState>(defaultMatchState);
  useEffect(() => {
    matchStateRef.current = matchState;
  }, [matchState]);

  useEffect(() => {
    if (matchState.phase !== 'live') return;
    setRoundGoVisible(true);
    const timeout = setTimeout(() => setRoundGoVisible(false), 900);
    return () => clearTimeout(timeout);
  }, [matchState.phase, matchState.roundNumber]);

  const [isDead, setIsDead] = useState(false);
  const [showDeathMenu, setShowDeathMenu] = useState(false);
  const [countdownVal, setCountdownVal] = useState<number | null>(null);
  const isDeadRef = useRef(false);
  const isLoopingRef = useRef(false);
  const handleRespawnRef = useRef<() => void>();

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
      reconnectionAttempts: 8,
      timeout: 15000
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

    socket.on('room:joined', (data: { success: boolean; roomCode: string; playerId: string; players: Record<string, PlayerState>; match?: MatchState; error?: string }) => {
      if (data.success) {
        const serverPlayer = data.players[data.playerId];
        if (serverPlayer) {
          stateRef.current.x = serverPlayer.x;
          stateRef.current.y = serverPlayer.y + 1.6;
          stateRef.current.z = serverPlayer.z;
          stateRef.current.yaw = serverPlayer.yaw || 0;
          stateRef.current.pitch = serverPlayer.pitch || 0;
          stateRef.current.vy = 0;
          stateRef.current.isGrounded = true;
        }
        setLocalPlayerId(data.playerId);
        setCurrentRoom(data.roomCode);
        setJoinedPlayers(data.players);
        setMatchState(data.match || defaultMatchState);
        setLocalHealth(100);
        stateRef.current.health = 100;
        setIsDead(false);
        isDeadRef.current = false;
        setShowDeathMenu(false);
        setCountdownVal(null);
        setInGame(true);
        setJoinError('');
      } else {
        setJoinError(data.error || 'Não foi possível entrar na sala.');
      }
    });

    socket.on('players:sync', (data: { players: Record<string, PlayerState>; match?: MatchState }) => {
      setJoinedPlayers(data.players);
      const self = socket.id ? data.players[socket.id] : undefined;
      if (self) {
        setLocalHealth(self.health);
        stateRef.current.health = self.health;
        if (self.health > 0 && self.isActive && data.match?.phase !== 'round_end') {
          setIsDead(false);
          isDeadRef.current = false;
          setShowDeathMenu(false);
        }
      }
      if (data.match) {
        setMatchState(data.match);
      }
    });

    socket.on('match:state', (data: MatchState) => {
      setMatchState(data);
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
        stateRef.current.y = data.y + 1.6; // camera eye-height compensation
        stateRef.current.z = data.z;
        cameraRef.current?.position.set(data.x, data.y + 1.6, data.z);
        cameraRef.current?.rotation.set(0, 0, 0);
        stateRef.current.vy = 0;
        stateRef.current.isGrounded = true;
        setIsDead(false);
        isDeadRef.current = false;
        setShowDeathMenu(false);
        setCountdownVal(null);
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
      setMatchState(defaultMatchState);
      setRoundGoVisible(false);
    setRoomCodeInput('');
    setPointerLocked(false);
    setIsDead(false);
    isDeadRef.current = false;
    setShowDeathMenu(false);
    setCountdownVal(null);
    document.exitPointerLock?.();
  };

  const handleRespawnReset = () => {
    setLocalHealth(100);
    stateRef.current.health = 100;
    
    // Spawn player at coordinates
    stateRef.current.x = (Math.random() * 6) - 3;
    stateRef.current.z = (Math.random() * 6) + 12;
    stateRef.current.vy = 0;
    stateRef.current.yaw = 0;
    stateRef.current.pitch = 0;
    
    // Revive bots in training
    if (currentRoom === 'TREINO') {
      setJoinedPlayers(prev => {
        const copy = { ...prev };
        if (copy['dummy1']) {
          copy['dummy1'].health = 100;
          copy['dummy1'].x = -12;
          copy['dummy1'].z = -18;
          copy['dummy1'].yaw = 0;
        }
        if (copy['dummy2']) {
          copy['dummy2'].health = 100;
          copy['dummy2'].x = 12;
          copy['dummy2'].z = -24;
          copy['dummy2'].yaw = 0;
        }
        return copy;
      });
    } else {
      if (socketRef.current) {
        socketRef.current.emit('player:respawn');
      }
    }
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
      team: 'police',
      isActive: true,
      health: 100,
      kills: 0,
      deaths: 0,
      color: '#1e3a8a', // Dark tactical navy blue
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      pitch: 0,
      isShooting: false
    };

    const dummy1: PlayerState = {
      id: 'dummy1',
      name: 'Recruta_Elite',
      team: 'thief',
      isActive: true,
      health: 100,
      kills: 0,
      deaths: 0,
      color: '#047857', // Forest/Military green
      x: -12,
      y: 0,
      z: -18,
      yaw: 0,
      pitch: 0,
      isShooting: false
    };

    const dummy2: PlayerState = {
      id: 'dummy2',
      name: 'Sargento_Alpha',
      team: 'thief',
      isActive: true,
      health: 100,
      kills: 0,
      deaths: 0,
      color: '#b45309', // Deep copper brown
      x: 12,
      y: 0,
      z: -24,
      yaw: 0,
      pitch: 0,
      isShooting: false
    };

    setJoinedPlayers({
      [soloId]: selfPlayer,
      [dummy1.id]: dummy1,
      [dummy2.id]: dummy2
    });

    setLocalHealth(100);
    setMatchState({
      ...defaultMatchState,
      phase: 'live',
      message: 'Treino',
      activePlayerIds: [soloId, dummy1.id, dummy2.id]
    });
    stateRef.current.health = 100;
    setIsDead(false);
    isDeadRef.current = false;
    setShowDeathMenu(false);
    setCountdownVal(null);
    
    // Spawn player at coordinates
    stateRef.current.x = (Math.random() * 6) - 3;
    stateRef.current.z = (Math.random() * 6) + 12; // spawn player slightly backwards

    setInGame(true);
    setJoinError('');
  };

  const copyRoomCode = () => {
    navigator.clipboard.writeText(currentRoom);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleRestartGameSequence = () => {
    setCountdownVal(3);
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    
    const playTickSound = (freq: number) => {
      try {
        const osc = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        osc.connect(gainNode);
        gainNode.connect(audioContext.destination);
        osc.frequency.setValueAtTime(freq, audioContext.currentTime);
        gainNode.gain.setValueAtTime(0.12, audioContext.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.15);
        osc.start();
        osc.stop(audioContext.currentTime + 0.18);
      } catch (err) {}
    };

    playTickSound(650);

    let currentCount = 3;
    const interval = setInterval(() => {
      currentCount -= 1;
      if (currentCount > 0) {
        setCountdownVal(currentCount);
        playTickSound(650);
      } else {
        clearInterval(interval);
        setCountdownVal(null);
        playTickSound(1100);
        
        handleRespawnRef.current?.();
      }
    }, 1000);
  };

  // Main 3D Canvas Lifecycle & Render Loop
  useEffect(() => {
    if (!inGame || !canvasRef.current) return;

    isLoopingRef.current = true;
    const canvas = canvasRef.current;
    
    // Smoke particles and bullet decals list containers
    const smokeParticles: { mesh: THREE.Mesh; maxLife: number; life: number; vel: THREE.Vector3 }[] = [];
    const bulletDecals: { mesh: THREE.Mesh; life: number }[] = [];

    // Persistent tracking states for offline combat bots
    const botAIStates: Record<string, { targetX: number; targetZ: number; changeTimer: number; shootCooldown: number }> = {
      dummy1: { targetX: -12, targetZ: -18, changeTimer: 0, shootCooldown: 0.8 },
      dummy2: { targetX: 12, targetZ: -24, changeTimer: 0, shootCooldown: 1.6 }
    };

    const spawnSmoke = (position: THREE.Vector3, count: number = 6) => {
      for (let i = 0; i < count; i++) {
        const smokeSize = Math.random() * 0.08 + 0.03;
        const smokeGeo = new THREE.SphereGeometry(smokeSize, 5, 5);
        const smokeMat = new THREE.MeshBasicMaterial({
          color: '#cbd5e1', // Slate grey gunpowder combustion smoke
          transparent: true,
          opacity: 0.45,
          depthWrite: false
        });
        const mesh = new THREE.Mesh(smokeGeo, smokeMat);
        mesh.position.copy(position).add(new THREE.Vector3(
          (Math.random() - 0.5) * 0.08,
          (Math.random() - 0.5) * 0.08,
          (Math.random() - 0.5) * 0.08
        ));
        scene.add(mesh);
        
        smokeParticles.push({
          mesh,
          maxLife: 35 + Math.floor(Math.random() * 15),
          life: 35 + Math.floor(Math.random() * 15),
          vel: new THREE.Vector3(
            (Math.random() - 0.5) * 0.4,
            Math.random() * 0.6 + 0.15, // slight thermal draft
            (Math.random() - 0.5) * 0.4
          )
        });
      }
    };

    const spawnBulletDecal = (hitPoint: THREE.Vector3, worldNormal: THREE.Vector3) => {
      const decalGeo = new THREE.CircleGeometry(0.065, 8);
      const decalMat = new THREE.MeshBasicMaterial({
        color: '#1c1917', // soot dark charcoal
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4
      });
      const decal = new THREE.Mesh(decalGeo, decalMat);
      decal.position.copy(hitPoint).addScaledVector(worldNormal, 0.002);
      decal.lookAt(decal.position.clone().add(worldNormal));
      
      scene.add(decal);
      bulletDecals.push({ mesh: decal, life: 100 });
      
      if (bulletDecals.length > 50) {
        const old = bulletDecals.shift();
        if (old) {
          scene.remove(old.mesh);
          old.mesh.geometry.dispose();
          (old.mesh.material as THREE.Material).dispose();
        }
      }
    };

    // 1. Initialize Three.js WebGL Renderer with Shadows and Fog
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1e293b'); // Tactical daytime warehouse slate grey
    
    // Smooth linear fog that keeps the direct view very clear and bright ("nao deixe escuro de mais")
    scene.fog = new THREE.Fog('#1e293b', 22, 85); // Pushed back fog to ensure perfect view under bright warehouse light

    const getCanvasSize = () => {
      const parent = canvas.parentElement;
      const width = canvas.clientWidth || parent?.clientWidth || window.innerWidth || 1;
      const height = canvas.clientHeight || parent?.clientHeight || window.innerHeight || 1;
      return { width, height };
    };

    const initialSize = getCanvasSize();
    const camera = new THREE.PerspectiveCamera(75, initialSize.width / initialSize.height, 0.1, 1000);
    cameraRef.current = camera;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setSize(initialSize.width, initialSize.height, false);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    
    // Enable realistic shadow mapping
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    handleRespawnRef.current = () => {
      const rx = (Math.random() * 6) - 3;
      const rz = (Math.random() * 6) + 12;
      camera.position.set(rx, 1.6, rz);
      camera.rotation.set(0, 0, 0);
      stateRef.current.vy = 0;
      stateRef.current.yaw = 0;
      stateRef.current.pitch = 0;
      stateRef.current.health = 100;
      setLocalHealth(100);
      setIsDead(false);
      isDeadRef.current = false;
      setShowDeathMenu(false);

      if (currentRoom === 'TREINO') {
        setJoinedPlayers(prev => {
          const copy = { ...prev };
          if (copy['dummy1']) {
            copy['dummy1'].health = 100;
            copy['dummy1'].x = -12;
            copy['dummy1'].z = -18;
          }
          if (copy['dummy2']) {
            copy['dummy2'].health = 100;
            copy['dummy2'].x = 12;
            copy['dummy2'].z = -24;
          }
          return copy;
        });
      } else {
        if (socketRef.current) {
          socketRef.current.emit('player:respawn');
        }
      }
      safeRequestPointerLock(canvas);
    };

    // Handle Window Resize via ResizeObserver to support split screens or canvas shifts seamlessly
    const handleCanvasResize = () => {
      requestAnimationFrame(() => {
        const { width, height } = getCanvasSize();
        if (!width || !height) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      });
    };

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(handleCanvasResize) : null;
    resizeObserver?.observe(canvas);
    window.addEventListener('resize', handleCanvasResize);

    // 2. Add Radiant Arena Lighting (Realistic Industrial Daylight)
    // Ambient baseline so shadows are never dark or pitch black
    const ambientLight = new THREE.AmbientLight('#ffffff', 0.65);
    scene.add(ambientLight);

    // Hemisphere light representing overhead blue sky dome and warm cyber bounce
    const hemiLight = new THREE.HemisphereLight('#f1f5f9', '#334155', 0.85); // Slate blue dome to warm concrete floor bounce
    hemiLight.position.set(0, 50, 0);
    scene.add(hemiLight);

    // Main warm golden directional sun light casting high quality shadows
    const skyLight = new THREE.DirectionalLight('#fffbeb', 2.5); // Rich warm direct sunlight
    skyLight.position.set(20, 50, 15);
    skyLight.castShadow = true;
    skyLight.shadow.mapSize.width = 2048;
    skyLight.shadow.mapSize.height = 2048;
    skyLight.shadow.camera.near = 0.5;
    skyLight.shadow.camera.far = 130;
    
    // Bounds fitting the 62x62 arena
    const d = 34;
    skyLight.shadow.camera.left = -d;
    skyLight.shadow.camera.right = d;
    skyLight.shadow.camera.top = d;
    skyLight.shadow.camera.bottom = -d;
    skyLight.shadow.bias = -0.0003;
    scene.add(skyLight);

    // Soft cool fill light from the opposite corner for realistic shadows
    const fillLight = new THREE.DirectionalLight('#94a3b8', 0.95);
    fillLight.position.set(-20, 35, -20);
    scene.add(fillLight);

    // 3. Build Realistic Industrial Concrete Floor
    const floorGeo = new THREE.PlaneGeometry(62, 62);
    const floorMat = new THREE.MeshStandardMaterial({ 
      color: '#2d3748', // Dusty graphite slate concrete grey
      roughness: 0.85,  // Matte non-reflective raw concrete surface textures
      metalness: 0.2
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = true;
    scene.add(floor);

    // Grid Floor Overlay representing factory floor panel tiles
    const gridHelper = new THREE.GridHelper(62, 31, '#475569', '#1e293b'); // Subtle industrial slate lines
    gridHelper.position.y = 0.005;
    scene.add(gridHelper);

    // Central Tactical Combat Ring Decal
    const ringGeo = new THREE.RingGeometry(5.8, 6.0, 32);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#52525b', side: THREE.DoubleSide }); // Matte dark grey tactical ring
    const centerRing = new THREE.Mesh(ringGeo, ringMat);
    centerRing.rotation.x = -Math.PI / 2;
    centerRing.position.set(0, 0.01, 0);
    scene.add(centerRing);

    // Floating corner decorative tactical hazard indicators
    const decGroup = new THREE.Group();
    const decLocs = [-28, 28];
    decLocs.forEach(dx => {
      decLocs.forEach(dz => {
        // Warning-yellow floor bounds marks
        const mGeo = new THREE.BoxGeometry(1.5, 0.01, 0.15);
        const mMat = new THREE.MeshBasicMaterial({ color: '#ca8a04' });
        
        const m1 = new THREE.Mesh(mGeo, mMat);
        m1.position.set(dx, 0.01, dz);
        decGroup.add(m1);

        const m2 = new THREE.Mesh(mGeo, mMat);
        m2.rotation.y = Math.PI / 2;
        m2.position.set(dx, 0.01, dz);
        decGroup.add(m2);
      });
    });
    scene.add(decGroup);

    // Outer Boundary Walls (Closed Arena)
    const wallHeight = 4.8;
    const boundaryWallsGroup = new THREE.Group();
    const wallMat = new THREE.MeshStandardMaterial({ 
      color: '#27272a', // Raw brick/concrete dark grey panels
      roughness: 0.85,
      metalness: 0.1
    });

    // North Wall
    const sideWallGeoNS = new THREE.BoxGeometry(62, wallHeight, 1.2);
    const wallN = new THREE.Mesh(sideWallGeoNS, wallMat);
    wallN.position.set(0, wallHeight / 2, -31);
    wallN.receiveShadow = true;
    wallN.castShadow = true;
    boundaryWallsGroup.add(wallN);

    // South Wall
    const wallS = new THREE.Mesh(sideWallGeoNS, wallMat);
    wallS.position.set(0, wallHeight / 2, 31);
    wallS.receiveShadow = true;
    wallS.castShadow = true;
    boundaryWallsGroup.add(wallS);

    // East Wall
    const sideWallGeoEW = new THREE.BoxGeometry(1.2, wallHeight, 62);
    const wallE = new THREE.Mesh(sideWallGeoEW, wallMat);
    wallE.position.set(31, wallHeight / 2, 0);
    wallE.receiveShadow = true;
    wallE.castShadow = true;
    boundaryWallsGroup.add(wallE);

    // West Wall
    const wallW = new THREE.Mesh(sideWallGeoEW, wallMat);
    wallW.position.set(-31, wallHeight / 2, 0);
    wallW.receiveShadow = true;
    wallW.castShadow = true;
    boundaryWallsGroup.add(wallW);

    scene.add(boundaryWallsGroup);

    // Steel support runners along the top of all perimeter walls
    const topGlowMat = new THREE.MeshStandardMaterial({ color: '#475569', roughness: 0.5, metalness: 0.8 });
    const wallGlowNGeo = new THREE.BoxGeometry(62, 0.15, 0.15);
    const wallGlowN = new THREE.Mesh(wallGlowNGeo, topGlowMat);
    wallGlowN.position.set(0, wallHeight - 0.07, -30.3);
    scene.add(wallGlowN);

    const wallGlowS = new THREE.Mesh(wallGlowNGeo, topGlowMat);
    wallGlowS.position.set(0, wallHeight - 0.07, 30.3);
    scene.add(wallGlowS);

    const wallGlowEGeo = new THREE.BoxGeometry(0.15, 0.15, 62);
    const wallGlowE = new THREE.Mesh(wallGlowEGeo, topGlowMat);
    wallGlowE.position.set(30.3, wallHeight - 0.07, 0);
    scene.add(wallGlowE);

    const wallGlowW = new THREE.Mesh(wallGlowEGeo, topGlowMat);
    wallGlowW.position.set(-30.3, wallHeight - 0.07, 0);
    scene.add(wallGlowW);

    // 4. Scatter Tactical Obstacles (Realistic Cargo Crates and Concrete Barriers)
    const obstacles: { box: THREE.Box3; mesh: THREE.Mesh }[] = [];
    const obstacleSpecs = [
      // Central Block Structure
      { size: [6, 4, 6] as [number, number, number], pos: [0, 2, 0] as [number, number, number], color: '#3f4e3c' }, // Olive Drab Base
      
      // Crates scattered
      { size: [2.5, 2.5, 2.5] as [number, number, number], pos: [-12, 1.25, -12] as [number, number, number], color: '#1c1917' }, // Dark wood / carbon
      { size: [3, 3, 3] as [number, number, number], pos: [12, 1.5, 12] as [number, number, number], color: '#1c1917' },
      { size: [2, 3.5, 2] as [number, number, number], pos: [-15, 1.75, 10] as [number, number, number], color: '#3f4e3c' },
      { size: [4, 2, 2] as [number, number, number], pos: [10, 1.0, -14] as [number, number, number], color: '#7c2d12' }, // Rust orange crate
      
      // Corners structures
      { size: [3, 4.5, 3] as [number, number, number], pos: [-24, 2.25, -24] as [number, number, number], color: '#27272a' },
      { size: [3, 4.5, 3] as [number, number, number], pos: [24, 2.25, -24] as [number, number, number], color: '#27272a' },
      { size: [3, 4.5, 3] as [number, number, number], pos: [-24, 2.25, 24] as [number, number, number], color: '#27272a' },
      { size: [3, 4.5, 3] as [number, number, number], pos: [24, 2.25, 24] as [number, number, number], color: '#27272a' }
    ];

    obstacleSpecs.forEach((spec) => {
      const g = new THREE.Group();
      g.position.set(...spec.pos);

      // Main structural block
      const geo = new THREE.BoxGeometry(...spec.size);
      const mat = new THREE.MeshStandardMaterial({ 
        color: spec.color,
        roughness: 0.8,
        metalness: 0.25
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData = { isObstacle: true };
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);

      // Detail framing
      const [sx, sy, sz] = spec.size;
      const trimMat = new THREE.MeshStandardMaterial({ color: '#52525b', roughness: 0.7, metalness: 0.6 });
      
      // Top plate collar
      const topPlateGeo = new THREE.BoxGeometry(sx + 0.1, 0.08, sz + 0.1);
      const topPlate = new THREE.Mesh(topPlateGeo, trimMat);
      topPlate.position.y = sy / 2;
      topPlate.castShadow = true;
      g.add(topPlate);

      // Bottom plate collar
      const bottomPlateGeo = new THREE.BoxGeometry(sx + 0.1, 0.08, sz + 0.1);
      const bottomPlate = new THREE.Mesh(bottomPlateGeo, trimMat);
      bottomPlate.position.y = -sy / 2;
      bottomPlate.receiveShadow = true;
      g.add(bottomPlate);

      // Tactical yellow hazard band warning
      const energyGeo = new THREE.BoxGeometry(sx + 0.04, 0.12, sz + 0.04);
      const energyMat = new THREE.MeshStandardMaterial({ 
        color: '#ca8a04', // Warning gold hazard stripe around containers
        roughness: 0.7
      });
      const energy = new THREE.Mesh(energyGeo, energyMat);
      energy.position.y = 0;
      g.add(energy);

      scene.add(g);

      // Solid collision bounding box mapping
      const box = new THREE.Box3().setFromObject(mesh);
      obstacles.push({ box, mesh });
    });

    // 4b. Add 4 Concrete Support Columns with steel collars (Tactical realism)
    const columnsSpecs = [
      { x: -18, z: -6 },
      { x: 18, z: 6 },
      { x: -6, z: 18 },
      { x: 6, z: -18 }
    ];

    columnsSpecs.forEach((col) => {
      const g = new THREE.Group();
      g.position.set(col.x, 0, col.z);

      // Heavy Iron Base
      const baseGeo = new THREE.CylinderGeometry(0.48, 0.55, 0.5, 8);
      const baseMat = new THREE.MeshStandardMaterial({ color: '#3f3f46', roughness: 0.5, metalness: 0.7 });
      const base = new THREE.Mesh(baseGeo, baseMat);
      base.position.y = 0.25;
      base.castShadow = true;
      base.receiveShadow = true;
      g.add(base);

      // Rugged Concrete Column Core
      const tubeGeo = new THREE.CylinderGeometry(0.35, 0.35, 3.8, 12);
      const tubeMat = new THREE.MeshStandardMaterial({ color: '#71717a', roughness: 0.9, metalness: 0.1 });
      const tube = new THREE.Mesh(tubeGeo, tubeMat);
      tube.position.y = 2.4;
      tube.castShadow = true;
      tube.receiveShadow = true;
      g.add(tube);

      // Supporting Iron collar (Rusted steel fitting midway)
      const collarGeo = new THREE.TorusGeometry(0.38, 0.06, 8, 16);
      const collarMat = new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.95 });
      const collar = new THREE.Mesh(collarGeo, collarMat);
      collar.rotation.x = Math.PI / 2;
      collar.position.y = 2.4;
      g.add(collar);

      scene.add(g);

      // Physics solid boundaries mapping for cover
      const box = new THREE.Box3().setFromCenterAndSize(
        new THREE.Vector3(col.x, 2.1, col.z),
        new THREE.Vector3(0.95, 4.2, 0.95)
      );
      obstacles.push({ box, mesh: base });
    });

    // 5. Create Local Player's Weapon (Detailed Tactical Assault Rifle with precision sight & muzzle)
    const localWeaponGroup = new THREE.Group();
    
    // Matte Graphite Gun Body
    const gunBodyGeo = new THREE.BoxGeometry(0.1, 0.08, 0.38);
    const gunBodyMat = new THREE.MeshStandardMaterial({ color: '#18181b', metalness: 0.8, roughness: 0.65 }); // Deep matte tactical black
    const gunBody = new THREE.Mesh(gunBodyGeo, gunBodyMat);
    gunBody.position.set(0, 0, 0);
    localWeaponGroup.add(gunBody);

    // Upper Iron sight / holographic sight scope
    const scopeGeo = new THREE.BoxGeometry(0.018, 0.035, 0.12);
    const scopeMat = new THREE.MeshStandardMaterial({ color: '#27272a', metalness: 0.8, roughness: 0.5 });
    const scope = new THREE.Mesh(scopeGeo, scopeMat);
    scope.position.set(0, 0.055, -0.05);
    localWeaponGroup.add(scope);

    // Precision optic lens (Dark blue anti-glare reflex sight rather than glowing neon)
    const lensGeo = new THREE.BoxGeometry(0.012, 0.012, 0.01);
    const lensMat = new THREE.MeshStandardMaterial({ color: '#1d4ed8', metalness: 0.9, roughness: 0.1 }); // realistic multi-coated lens
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.position.set(0, 0.055, -0.11);
    localWeaponGroup.add(lens);

    // Ruffled gun barrel muzzle
    const muzzleGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.16, 8);
    const muzzleMat = new THREE.MeshStandardMaterial({ color: '#3f3f46', metalness: 0.85, roughness: 0.35 }); // gunmetal steel barrel
    const muzzle = new THREE.Mesh(muzzleGeo, muzzleMat);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0, -0.25);
    localWeaponGroup.add(muzzle);

    // Walnut wood tactical custom handguard (adds a high-quality realism polish)
    const gunNeonGeo = new THREE.BoxGeometry(0.112, 0.02, 0.18);
    const gunNeonMat = new THREE.MeshStandardMaterial({ color: '#7c2d12', roughness: 0.9, metalness: 0.1 }); // Walnut/mahogany composite body plating
    const gunNeon = new THREE.Mesh(gunNeonGeo, gunNeonMat);
    gunNeon.position.set(0, 0.015, -0.04);
    localWeaponGroup.add(gunNeon);

    // Assemble Gun relative offsets
    localWeaponGroup.position.set(0.18, -0.22, -0.38); // front & right side of view
    camera.add(localWeaponGroup);
    scene.add(camera);

    // Initial positioning from state (which is randomized by server on launch)
    camera.position.set(stateRef.current.x, stateRef.current.y, stateRef.current.z);

    // 6. Handle Remote Players 3D Avatar Rendering Maps (Stunning sci-fi modules)
    const remotePlayersMeshes: Record<string, {
      group: THREE.Group;
      head: THREE.Mesh;
      body: THREE.Mesh;
      leftLeg: THREE.Mesh;
      rightLeg: THREE.Mesh;
      armL: THREE.Mesh;
      armR: THREE.Mesh;
      lasers: THREE.Line[];
      hitbox: THREE.Mesh; // Invisible simplified direct bbox mesh to cast rays accurately
      lastX: number;
      lastZ: number;
      walkCycle: number;
    }> = {};

    const createRemotePlayerMesh = (p: PlayerState) => {
      const g = new THREE.Group();
      
      // Avatar Color theme or Team identifiers
      const skinColor = p.color || '#fb923c';
      const clothesColor = '#1e1b4b'; // Sleek dark jumpsuit base

      // Head Cube
      const headGeo = new THREE.BoxGeometry(0.48, 0.48, 0.48);
      const headMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.5 });
      const head = new THREE.Mesh(headGeo, headMat);
      head.position.y = 1.05; // Relative to player origin Y
      head.castShadow = true;
      g.add(head);

      // Tech Helmet Visor (Gives direction to remote models clearly)
      const visorGeo = new THREE.BoxGeometry(0.52, 0.12, 0.3);
      const visorMat = new THREE.MeshBasicMaterial({ color: skinColor === '#fb7185' ? '#06b6d4' : '#fb7185' }); // alternating high-contrast visor
      const visor = new THREE.Mesh(visorGeo, visorMat);
      visor.position.set(0, 0.08, -0.16);
      head.add(visor);

      // Torso Jumpsuit Block
      const torsoGeo = new THREE.BoxGeometry(0.66, 0.88, 0.32);
      const torsoMat = new THREE.MeshStandardMaterial({ color: clothesColor, roughness: 0.6, metalness: 0.5 });
      const torso = new THREE.Mesh(torsoGeo, torsoMat);
      torso.position.y = 0.38;
      torso.castShadow = true;
      torso.receiveShadow = true;
      g.add(torso);

      // Detailed Shoulder Plates (Pauldrons)
      const padGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
      const padMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.3, metalness: 0.7 });
      
      const leftPad = new THREE.Mesh(padGeo, padMat);
      leftPad.position.set(-0.4, 0.4, 0);
      leftPad.castShadow = true;
      torso.add(leftPad);

      const rightPad = leftPad.clone();
      rightPad.position.x = 0.4;
      torso.add(rightPad);

      // Back Jetpack Fuel Thruster
      const jetpackGeo = new THREE.BoxGeometry(0.35, 0.55, 0.14);
      const jetpackMat = new THREE.MeshStandardMaterial({ color: '#334155', metalness: 0.8, roughness: 0.3 });
      const jetpack = new THREE.Mesh(jetpackGeo, jetpackMat);
      jetpack.position.set(0, 0.38, 0.21);
      jetpack.castShadow = true;
      g.add(jetpack);
      
      const nozzleGeo = new THREE.CylinderGeometry(0.06, 0.04, 0.12, 8);
      const nozzleMat = new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.1, metalness: 0.9 });
      
      const nozzleL = new THREE.Mesh(nozzleGeo, nozzleMat);
      nozzleL.rotation.x = Math.PI / 2;
      nozzleL.position.set(-0.1, -0.28, 0);
      jetpack.add(nozzleL);

      const nozzleR = nozzleL.clone();
      nozzleR.position.x = 0.1;
      jetpack.add(nozzleR);

      // Left Arm
      const leftArmGeo = new THREE.BoxGeometry(0.18, 0.72, 0.18);
      const armMat = new THREE.MeshStandardMaterial({ color: skinColor, roughness: 0.6 });
      const leftArm = new THREE.Mesh(leftArmGeo, armMat);
      leftArm.position.set(-0.43, 0.38, 0);
      leftArm.castShadow = true;
      g.add(leftArm);

      // Right Arm (Pointing weapon forward)
      const rightArmGeo = new THREE.BoxGeometry(0.18, 0.72, 0.18);
      const rightArm = new THREE.Mesh(rightArmGeo, armMat);
      rightArm.position.set(0.43, 0.38, -0.15);
      rightArm.rotation.x = -Math.PI / 3; // hand pointed forward
      rightArm.castShadow = true;
      g.add(rightArm);

      // Carry Pistol Block
      const repPistolGeo = new THREE.BoxGeometry(0.08, 0.08, 0.24);
      const repPistolMat = new THREE.MeshStandardMaterial({ color: '#0f172a', metalness: 0.9, roughness: 0.1 });
      const repPistol = new THREE.Mesh(repPistolGeo, repPistolMat);
      repPistol.position.set(0, -0.28, -0.15);
      rightArm.add(repPistol);

      // Left Leg
      const legMat = new THREE.MeshStandardMaterial({ color: '#0f172a', roughness: 0.8, metalness: 0.3 });
      const leftLegGeo = new THREE.BoxGeometry(0.2, 0.55, 0.2);
      const leftLeg = new THREE.Mesh(leftLegGeo, legMat);
      leftLeg.position.set(-0.2, -0.32, 0);
      leftLeg.castShadow = true;
      g.add(leftLeg);

      // Right Leg
      const rightLegGeo = new THREE.BoxGeometry(0.2, 0.55, 0.2);
      const rightLeg = new THREE.Mesh(rightLegGeo, legMat);
      rightLeg.position.set(0.2, -0.32, 0);
      rightLeg.castShadow = true;
      g.add(rightLeg);

      // Invisible Capsule hitbox for simplified rapid raycast checks
      const hitboxGeo = new THREE.BoxGeometry(0.85, 2.0, 0.85);
      const hitboxMat = new THREE.MeshBasicMaterial({ visible: false });
      const hitbox = new THREE.Mesh(hitboxGeo, hitboxMat);
      hitbox.position.y = 0.5;
      hitbox.name = `remote-player-hitbox:${p.id}`; // marker tag to map ray hit
      g.add(hitbox);

      scene.add(g);
      return { 
        group: g, 
        head, 
        body: torso, 
        leftLeg, 
        rightLeg, 
        armL: leftArm, 
        armR: rightArm, 
        lasers: [], 
        hitbox, 
        lastX: p.x, 
        lastZ: p.z, 
        walkCycle: 0 
      };
    };

    // Keep remote representations perfectly aligned and animated with local frames
    const syncRemotePlayers = () => {
      const activePlayers = joinedPlayersRef.current;
      const myId = socketRef.current?.id || localPlayerId;

      // Check for removed players
      Object.keys(remotePlayersMeshes).forEach((id) => {
        if (!activePlayers[id] || id === myId) {
          scene.remove(remotePlayersMeshes[id].group);
          const tagEl = document.getElementById(`remote-tag-${id}`);
          if (tagEl) tagEl.style.display = 'none';
          delete remotePlayersMeshes[id];
        }
      });

      // Spawn or update active players
      Object.keys(activePlayers).forEach((id) => {
        if (id === myId) return; // skip self

        const p = activePlayers[id];
        if (!p.isActive || p.health <= 0) {
          if (remotePlayersMeshes[id]) {
            remotePlayersMeshes[id].group.visible = false;
            const tagEl = document.getElementById(`remote-tag-${id}`);
            if (tagEl) tagEl.style.display = 'none';
          }
          return;
        }

        if (!remotePlayersMeshes[id]) {
          remotePlayersMeshes[id] = createRemotePlayerMesh(p);
        }

        const rm = remotePlayersMeshes[id];
        rm.group.visible = true;

        // Position remote models with positive standing offset so their boots rest perfectly flat
        rm.group.position.set(p.x, p.y + 0.595, p.z);
        rm.group.rotation.y = p.yaw;
        rm.head.rotation.x = p.pitch;

        // Active leg walking animations based on position displacements
        const dx = p.x - rm.lastX;
        const dz = p.z - rm.lastZ;
        const movementDist = Math.sqrt(dx * dx + dz * dz);
        
        // Use a threshold to detect movement
        if (movementDist > 0.005) {
          // Increment cycle based on standard movement intervals
          rm.walkCycle += movementDist * 8.5;
          
          rm.leftLeg.rotation.x = Math.sin(rm.walkCycle) * 0.5;
          rm.rightLeg.rotation.x = -Math.sin(rm.walkCycle) * 0.5;
          rm.armL.rotation.x = -Math.sin(rm.walkCycle) * 0.4;
          rm.armR.rotation.x = -Math.PI / 3 + Math.sin(rm.walkCycle) * 0.25;
        } else {
          // Smoothly decay walking rotations back to idle standing postures
          const decayRate = 0.12;
          rm.leftLeg.rotation.x += (0 - rm.leftLeg.rotation.x) * decayRate;
          rm.rightLeg.rotation.x += (0 - rm.rightLeg.rotation.x) * decayRate;
          rm.armL.rotation.x += (0 - rm.armL.rotation.x) * decayRate;
          rm.armR.rotation.x += (-Math.PI / 3 - rm.armR.rotation.x) * decayRate;
        }

        rm.lastX = p.x;
        rm.lastZ = p.z;

        // Color flash remote torso red when they trigger weapons
        const bodyMat = rm.body.material as THREE.MeshStandardMaterial;
        if (p.isShooting) {
          bodyMat.color.set('#f43f5e'); // red flash on fire
        } else {
          bodyMat.color.set('#1e1b4b');
        }

        // Project the 3D player tag coordinates to 2D HTML Name Tags perfectly
        const tagEl = document.getElementById(`remote-tag-${id}`);
        if (tagEl) {
          const projVector = new THREE.Vector3(p.x, p.y + 1.62, p.z); // target right above head level
          projVector.project(camera);
          
          // If behind camera view screen, keep hidden
          if (projVector.z > 1.0) {
            tagEl.style.display = 'none';
          } else {
            const widthHalf = canvas.clientWidth / 2;
            const heightHalf = canvas.clientHeight / 2;
            const screenX = (projVector.x * widthHalf) + widthHalf;
            const screenY = -(projVector.y * heightHalf) + heightHalf;
            
            tagEl.style.display = 'flex';
            tagEl.className = 'absolute -translate-x-1/2 -translate-y-full flex flex-col items-center';
            tagEl.style.left = `${screenX}px`;
            tagEl.style.top = `${screenY}px`;
          }
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
      const laserMat = new THREE.LineBasicMaterial({ color: '#f43f5e', linewidth: 2 });
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

      const sensitivity = sensitivityRef.current;
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
      safeRequestPointerLock(canvas);
    });

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);

    // Fire mechanics on Click
    const handleMouseClick = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      if (stateRef.current.health <= 0) return; // Cant shoot if dead
      const localPlayerState = joinedPlayersRef.current[localPlayerId];
      const roundIsLive = currentRoom === 'TREINO' || (matchStateRef.current.phase === 'live' && localPlayerState?.isActive);
      if (!roundIsLive) return;

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

      // Gun muzzle smoke simulation
      const muzzleWorldPos = new THREE.Vector3(0.18, -0.22, -0.85).applyMatrix4(camera.matrixWorld);
      spawnSmoke(muzzleWorldPos, 5);

      // Hit Verification via central Raycast
      const raycaster = new THREE.Raycaster();
      // Center coordinates represent the exact crosshair target pixel
      raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);

      // Collect all checkable hitboxes (excluding self)
      const targetHitboxes = Object.values(remotePlayersMeshes).map(item => item.hitbox);
      const arenaObstaclesMesh = obstacles.map(item => item.mesh);

      // Intersect both players and walls/pillars to block double hits behind structures
      const intersects = raycaster.intersectObjects([...targetHitboxes, ...arenaObstaclesMesh]);

      // Draw local gorgeous amber golden tracer trail
      let tracerEnd = new THREE.Vector3();
      const cameraDir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      tracerEnd.copy(camera.position).addScaledVector(cameraDir, 50);

      if (intersects.length > 0) {
        tracerEnd.copy(intersects[0].point);
      }

      const traceGeo = new THREE.BufferGeometry().setFromPoints([muzzleWorldPos, tracerEnd]);
      const traceMat = new THREE.LineBasicMaterial({ color: '#ca8a04', linewidth: 1.5 }); // warm bronze bullet tracer
      const traceLine = new THREE.Line(traceGeo, traceMat);
      scene.add(traceLine);
      setTimeout(() => {
        scene.remove(traceLine);
        traceGeo.dispose();
        traceMat.dispose();
      }, 65);

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
        } else {
          // Hits walls, boundary margins, columns or custom obstacles! Place a bullet impact decal
          const hitPoint = intersects[0].point;
          let worldNormal = new THREE.Vector3(0, 1, 0);
          if (intersects[0].face) {
            worldNormal.copy(intersects[0].face.normal).transformDirection(hitObj.matrixWorld);
          }
          spawnBulletDecal(hitPoint, worldNormal);
        }
      }
    };

    window.addEventListener('mousedown', handleMouseClick);

    // 8. Core Animation Physics and Networking Update loops
    let lastTime = performance.now();
    let syncThrottleCounter = 0;

    const gameLoop = () => {
      if (!isLoopingRef.current) return;
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1); // caps maximum delta frame to prevent clipping on freeze
      lastTime = now;

      const localPlayerState = joinedPlayersRef.current[localPlayerId];
      const roundIsLive = currentRoom === 'TREINO' || (matchStateRef.current.phase === 'live' && localPlayerState?.isActive);

      if (stateRef.current.health > 0) {
        // Player locomotion physics (Keyboard reading WASD status)
        const moveVector = new THREE.Vector3();
        
        if (roundIsLive) {
          if (keysPressed.has('KeyW') || keysPressed.has('ArrowUp')) moveVector.z -= 1.0;
          if (keysPressed.has('KeyS') || keysPressed.has('ArrowDown')) moveVector.z += 1.0;
          if (keysPressed.has('KeyA') || keysPressed.has('ArrowLeft')) moveVector.x -= 1.0;
          if (keysPressed.has('KeyD') || keysPressed.has('ArrowRight')) moveVector.x += 1.0;
        }

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

        // Boundary Clamp inside Arena (floor is 62x62 boundary walls at 31)
        const arenaLimit = 29.8;
        const playerRadius = 0.45;

        // Axis-separated movement and collision resolution for perfect wall sliding & clipping prevention
        // 1. Move and resolve on X axis
        let currentX = camera.position.x;
        let originalX = currentX;
        let targetX = currentX + finalDisplacement.x;
        let clampedX = Math.max(-arenaLimit, Math.min(arenaLimit, targetX));

        let futureBoxX = new THREE.Box3(
          new THREE.Vector3(clampedX - playerRadius, camera.position.y - 1.6, camera.position.z - playerRadius),
          new THREE.Vector3(clampedX + playerRadius, camera.position.y + 0.4, camera.position.z + playerRadius)
        );

        for (let i = 0; i < obstacles.length; i++) {
          const { box } = obstacles[i];
          if (futureBoxX.intersectsBox(box)) {
            const overlapX = Math.min(futureBoxX.max.x - box.min.x, box.max.x - futureBoxX.min.x);
            if (originalX < box.min.x) {
              clampedX -= (overlapX + 0.01);
            } else {
              clampedX += (overlapX + 0.01);
            }
            futureBoxX.min.x = clampedX - playerRadius;
            futureBoxX.max.x = clampedX + playerRadius;
          }
        }
        camera.position.x = clampedX;

        // 2. Move and resolve on Z axis
        let currentZ = camera.position.z;
        let originalZ = currentZ;
        let targetZ = currentZ + finalDisplacement.z;
        let clampedZ = Math.max(-arenaLimit, Math.min(arenaLimit, targetZ));

        let futureBoxZ = new THREE.Box3(
          new THREE.Vector3(camera.position.x - playerRadius, camera.position.y - 1.6, clampedZ - playerRadius),
          new THREE.Vector3(camera.position.x + playerRadius, camera.position.y + 0.4, clampedZ + playerRadius)
        );

        for (let i = 0; i < obstacles.length; i++) {
          const { box } = obstacles[i];
          if (futureBoxZ.intersectsBox(box)) {
            const overlapZ = Math.min(futureBoxZ.max.z - box.min.z, box.max.z - futureBoxZ.min.z);
            if (originalZ < box.min.z) {
              clampedZ -= (overlapZ + 0.01);
            } else {
              clampedZ += (overlapZ + 0.01);
            }
            futureBoxZ.min.z = clampedZ - playerRadius;
            futureBoxZ.max.z = clampedZ + playerRadius;
          }
        }
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
          if (roundIsLive && keysPressed.has('Space')) {
            stateRef.current.vy = 8.5; // push vertical force
            stateRef.current.isGrounded = false;
          }
        }

        // Apply camera rotational yaw/pitch vectors to 3D orientation matrices
        camera.rotation.order = 'YXZ';
        camera.rotation.y = stateRef.current.yaw;
        camera.rotation.x = stateRef.current.pitch;
        camera.rotation.z = THREE.MathUtils.lerp(camera.rotation.z, 0, 10 * dt);

        // Clean fluid weapon bobbing and sway based on walk/idle state
        const isWalking = translationForce.lengthSq() > 0.0001;
        const bobCycle = isWalking ? now * 0.012 : now * 0.0035; // gentle breath on idle, swift when moving
        const bobScaleX = isWalking ? 0.012 : 0.003;
        const bobScaleY = isWalking ? 0.009 : 0.002;

        const targetSwayX = 0.18 + Math.cos(bobCycle) * bobScaleX;
        const targetSwayY = -0.22 + Math.sin(bobCycle * 2) * bobScaleY;

        localWeaponGroup.position.x = THREE.MathUtils.lerp(localWeaponGroup.position.x, targetSwayX, 10 * dt);
        localWeaponGroup.position.y = THREE.MathUtils.lerp(localWeaponGroup.position.y, targetSwayY, 10 * dt);
        localWeaponGroup.position.z = THREE.MathUtils.lerp(localWeaponGroup.position.z, -0.38, 12 * dt);
      } else {
        // Drop camera on the floor (standingY = 1.6 -> camera.position.y -> 0.35)
        camera.position.y = THREE.MathUtils.lerp(camera.position.y, 0.35, 4 * dt);
        camera.rotation.z = THREE.MathUtils.lerp(camera.rotation.z, Math.PI / 4.5, 3 * dt);
        camera.rotation.x = THREE.MathUtils.lerp(camera.rotation.x, -0.2, 3 * dt);

        if (!isDeadRef.current) {
          isDeadRef.current = true;
          setIsDead(true);
          document.exitPointerLock?.();
          
          setTimeout(() => {
            setShowDeathMenu(true);
          }, 1500);
        }
      }

      // Rotate, rise, shrink, and fade out muzzle smoke particles with thermal draft
      for (let i = smokeParticles.length - 1; i >= 0; i--) {
        const p = smokeParticles[i];
        p.life -= 1;
        p.mesh.position.addScaledVector(p.vel, dt);
        
        // Slowly shrink scale and fade opacity
        const lifeRatio = p.life / p.maxLife;
        p.mesh.scale.setScalar(lifeRatio);
        
        const mat = p.mesh.material as THREE.MeshBasicMaterial;
        mat.opacity = lifeRatio * 0.45;
        
        if (p.life <= 0) {
          scene.remove(p.mesh);
          p.mesh.geometry.dispose();
          mat.dispose();
          smokeParticles.splice(i, 1);
        }
      }

      // Fade out bullet decals slowly over their lifespan
      for (let i = bulletDecals.length - 1; i >= 0; i--) {
        const d = bulletDecals[i];
        d.life -= dt * 4.5; // slow expiration rate
        if (d.life <= 0) {
          scene.remove(d.mesh);
          d.mesh.geometry.dispose();
          (d.mesh.material as THREE.Material).dispose();
          bulletDecals.splice(i, 1);
        } else {
          const mat = d.mesh.material as THREE.MeshBasicMaterial;
          if (d.life < 20) {
            mat.opacity = d.life / 20;
          }
        }
      }

      // Update stateRef container variables
      stateRef.current.x = camera.position.x;
      stateRef.current.y = camera.position.y;
      stateRef.current.z = camera.position.z;
      stateRef.current.isShooting = keysPressed.has('KeyF'); // auxiliary shooting flag if mouse click fails

      // Synchronize player position with the server 30 times a second (saving container network band)
      syncThrottleCounter++;
      if (roundIsLive && syncThrottleCounter >= 2) {
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

      // If we are in local TREINO (Practice Mode), execute advanced hostile intelligence for Recruta_Elite and Sargento_Alpha
      if (currentRoom === 'TREINO') {
        const botIds = ['dummy1', 'dummy2'];
        
        botIds.forEach(bId => {
          const bot = joinedPlayersRef.current[bId];
          if (!bot) return;

          const ai = botAIStates[bId];
          if (!ai) return;

          // If the bot has no health left, they remain down (defeated state)
          if (bot.health <= 0) {
            return;
          }

          // 1. Pathing & Movement AI (Dodge movement within the arena)
          const curPos = new THREE.Vector3(bot.x, 0, bot.z);
          const tgtPos = new THREE.Vector3(ai.targetX, 0, ai.targetZ);
          const distToTgt = curPos.distanceTo(tgtPos);

          ai.changeTimer -= dt;
          if (distToTgt < 1.2 || ai.changeTimer <= 0) {
            // Pick a new combat position inside the 62x62 boundary to circle or duck behind cover
            ai.targetX = (Math.random() * 42) - 21;
            ai.targetZ = (Math.random() * 42) - 21;
            ai.changeTimer = Math.random() * 4.0 + 3.0; // shift heading every 3-7 seconds
          }

          // Steer smoothly towards target position
          const dirToTgt = tgtPos.clone().sub(curPos).normalize();
          let speedFactor = 1.0;
          if (botDifficultyRef.current === 'easy') {
            speedFactor = 0.65;
          } else if (botDifficultyRef.current === 'hardcore') {
            speedFactor = 1.4;
          }
          const speed = (bId === 'dummy1' ? 3.6 : 2.8) * speedFactor;
          
          curPos.addScaledVector(dirToTgt, speed * dt);
          bot.x = curPos.x;
          bot.z = curPos.z;

          // 2. Head & Arm Aiming direction towards player
          const playerPosVec = new THREE.Vector3(camera.position.x, 0, camera.position.z);
          const dirToPlayer = playerPosVec.clone().sub(new THREE.Vector3(bot.x, 0, bot.z));
          const distToPlayer = dirToPlayer.length();
          dirToPlayer.normalize();

          // Heading yaw rotation to look at player
          bot.yaw = Math.atan2(dirToPlayer.x, dirToPlayer.z);

          // Vertical look pitch estimation
          const dY = camera.position.y - 0.9;
          bot.pitch = Math.atan2(dY, distToPlayer);

          // 3. Raycast Line-of-Sight and shooting logic
          const botChest = new THREE.Vector3(bot.x, 0.9, bot.z);
          const playerHead = new THREE.Vector3(camera.position.x, camera.position.y - 0.2, camera.position.z);
          const losDir = playerHead.clone().sub(botChest);
          const losDist = losDir.length();
          losDir.normalize();

          const losRay = new THREE.Raycaster(botChest, losDir, 0.1, 45);
          const arenaObstaclesMesh = obstacles.map(item => item.mesh);
          const intersects = losRay.intersectObjects(arenaObstaclesMesh);

          let hasLOS = true;
          if (intersects.length > 0) {
            // If closest wall hit is closer than local player, blocked view!
            if (intersects[0].distance < losDist) {
              hasLOS = false;
            }
          }

          // If player is alive and within range and we have direct sighting
          if (hasLOS && stateRef.current.health > 0 && losDist < 36) {
            ai.shootCooldown -= dt;
            if (ai.shootCooldown <= 0) {
              // Reset tactical firing countdown depending on selected difficulty
              let baseCooldown = 1.0;
              if (botDifficultyRef.current === 'easy') {
                baseCooldown = Math.random() * 1.5 + 1.6; // slow firing
              } else if (botDifficultyRef.current === 'hardcore') {
                baseCooldown = Math.random() * 0.35 + 0.45; // ultra fast
              } else {
                baseCooldown = Math.random() * 0.75 + 0.85; // medium
              }
              ai.shootCooldown = baseCooldown;

              // Fire gunshot sound
              playGunshotSound();

              // Trigger barrel muzzle smoke
              const botMuzzle = botChest.clone().addScaledVector(losDir, 0.85);
              spawnSmoke(botMuzzle, 4);

              // Firing muzzle light
              const botFlash = new THREE.PointLight('#fbbf24', 4, 3);
              botFlash.position.copy(botMuzzle);
              scene.add(botFlash);
              setTimeout(() => scene.remove(botFlash), 50);

              // Aiming spread accuracy bounds scaled by difficulty level
              let diffSpreadMod = 1.0;
              if (botDifficultyRef.current === 'easy') {
                diffSpreadMod = 2.2;
              } else if (botDifficultyRef.current === 'hardcore') {
                diffSpreadMod = 0.5;
              }
              const spreadFactor = (bId === 'dummy1' ? 0.38 : 0.22) * diffSpreadMod;
              const tracerEnd = playerHead.clone().add(new THREE.Vector3(
                (Math.random() - 0.5) * spreadFactor * 2,
                (Math.random() - 0.5) * spreadFactor * 2,
                (Math.random() - 0.5) * spreadFactor * 2
              ));

              // Draw beautiful bronze bullet tracer trail line
              const tracerGeo = new THREE.BufferGeometry().setFromPoints([botMuzzle, tracerEnd]);
              const tracerMat = new THREE.LineBasicMaterial({ color: '#f59e0b', linewidth: 1.5 });
              const tracerLine = new THREE.Line(tracerGeo, tracerMat);
              scene.add(tracerLine);
              setTimeout(() => {
                scene.remove(tracerLine);
                tracerGeo.dispose();
                tracerMat.dispose();
              }, 65);

              // Verify damage landing
              const errorMag = tracerEnd.distanceTo(playerHead);
              if (errorMag < 0.65) {
                // Precise Shot landed on the player! Deduct health
                const damage = bId === 'dummy1' ? 12 : 18; // Sargento Alpha delivers heavier punch
                const nextHp = Math.max(0, stateRef.current.health - damage);
                
                stateRef.current.health = nextHp;
                setLocalHealth(nextHp);

                // Flash red viewport spatter warning
                setLocalHealthFlashAlert(true);
                setTimeout(() => setLocalHealthFlashAlert(false), 200);
                playHitSound();

                if (nextHp <= 0) {
                  const feedId = Math.random().toString();
                  const killFeedEntry: KillFeedEntry = {
                    id: feedId,
                    attacker: bot.name,
                    victim: playerName,
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  };
                  setKillFeed(feed => [killFeedEntry, ...feed].slice(0, 5));
                  playEliminationSound();
                  setTimeout(() => {
                    setKillFeed(feed => feed.filter(f => f.id !== feedId));
                  }, 4500);

                  // Set score death counter
                  setJoinedPlayers(next => {
                    const copy = { ...next };
                    if (copy['solo']) copy['solo'].deaths += 1;
                    if (copy[bId]) copy[bId].kills += 1;
                    return copy;
                  });
                }
              } else {
                // Shot missed player! Raycast trail directly over wall, paint wall impact bullet decal
                const bulletRay = new THREE.Raycaster(botMuzzle, tracerEnd.clone().sub(botMuzzle).normalize());
                const wallHits = bulletRay.intersectObjects(arenaObstaclesMesh);
                if (wallHits.length > 0) {
                  const hPoint = wallHits[0].point;
                  const hNormal = wallHits[0].face ? wallHits[0].face.normal.clone().transformDirection(wallHits[0].object.matrixWorld) : new THREE.Vector3(0, 1, 0);
                  spawnBulletDecal(hPoint, hNormal);
                }
              }
            }
          }

          bot.isShooting = (ai.shootCooldown < 0.1);
        });
      }

      // Synchronize remote player block representation states
      syncRemotePlayers();

      // Dynamic weapon skin configuration update
      if (gunBodyMat) {
        if (selectedSkinRef.current === 'gold') {
          gunBodyMat.color.set('#eab308'); // Golden yellow/brass
          gunBodyMat.metalness = 0.95;
          gunBodyMat.roughness = 0.12;
        } else if (selectedSkinRef.current === 'arctic') {
          gunBodyMat.color.set('#f8fafc'); // Arctic white
          gunBodyMat.metalness = 0.15;
          gunBodyMat.roughness = 0.8;
        } else if (selectedSkinRef.current === 'rust') {
          gunBodyMat.color.set('#b45309'); // Rust orange copper/walnut wood warmth
          gunBodyMat.metalness = 0.65;
          gunBodyMat.roughness = 0.45;
        } else {
          // Classic Graphite Matte Black
          gunBodyMat.color.set('#18181b');
          gunBodyMat.metalness = 0.8;
          gunBodyMat.roughness = 0.65;
        }
      }

      // Fire Render Frame
      renderer.render(scene, camera);
      requestAnimationFrame(gameLoop);
    };

    const animFrameId = requestAnimationFrame(gameLoop);

    // Clean up Three.js objects of the room on component shift/unmount
    return () => {
      isLoopingRef.current = false;
      cameraRef.current = null;
      cancelAnimationFrame(animFrameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', handleCanvasResize);
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

  const localPlayerState = joinedPlayers[localPlayerId];
  const isNetworkRoom = inGame && currentRoom !== 'TREINO';
  const isRoundLive = !isNetworkRoom || (matchState.phase === 'live' && localPlayerState?.isActive);
  const roundOverlayText = !isNetworkRoom
    ? ''
    : !localPlayerState?.isActive
      ? 'Aguardando próxima rodada'
      : matchState.phase === 'waiting'
        ? 'Aguardando oponente'
        : matchState.phase === 'countdown'
          ? String(matchState.countdown ?? 3)
        : matchState.phase === 'round_end'
          ? matchState.message
          : matchState.phase === 'live' && roundGoVisible
            ? 'GO'
            : '';
  const roundOverlaySubtext = !isNetworkRoom
    ? ''
    : !localPlayerState?.isActive
      ? 'Você entra quando o round atual terminar'
      : matchState.phase === 'waiting'
        ? 'A partida começa quando outro jogador entrar'
        : matchState.phase === 'countdown'
          ? 'Prepare-se'
          : matchState.phase === 'round_end'
            ? 'Próximo round em instantes'
            : matchState.phase === 'live' && roundGoVisible
              ? 'Round valendo'
              : '';

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
            className="absolute inset-0 w-full h-full block outline-none cursor-crosshair" 
          />

          {/* VISUAL DAMAGE BLOOD FLASH INDICATOR */}
          {localHealthFlashAlert && (
            <div 
              id="hud-blood-flash" 
              className="absolute inset-0 border-[20px] sm:border-[40px] border-red-600/35 pointer-events-none z-40 animate-pulse transition-all duration-75" 
            />
          )}

          {/* TACTICAL ESCAPE / PAUSED GAME MENU OVERLAY (WHEN UNLOCKED) */}
          {!pointerLocked && isRoundLive && !isDead && !showDeathMenu && countdownVal === null && (
            <div 
              id="pointer-lock-overlay" 
              className="absolute inset-0 bg-slate-950/85 flex flex-col items-center justify-center p-4 sm:p-6 text-center z-30 transition-all backdrop-blur-sm"
              onClick={() => {
                safeRequestPointerLock(canvasRef.current);
              }}
            >
              <div 
                id="esc-menu-card" 
                className="max-w-xs w-full bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl flex flex-col gap-4 text-left animate-fade-in cursor-default"
                onClick={(e) => {
                  e.stopPropagation();
                }}
              >
                {/* MENU HEADER */}
                <div id="esc-menu-header" className="flex items-center justify-between">
                  <h3 className="text-sm font-black text-white tracking-widest uppercase flex items-center gap-1.5">
                    <Sliders className="w-4 h-4 text-rose-500" /> PAUSA
                  </h3>
                  <span className="text-[9px] text-rose-400 font-bold tracking-wider bg-rose-950/40 border border-rose-900/40 px-2 py-0.5 rounded-md uppercase">
                    {currentRoom === 'TREINO' ? 'Treino' : 'Rede'}
                  </span>
                </div>

                <div className="space-y-3">
                  {/* SLIDER: MOUSE SENSITIVITY */}
                  <div className="bg-slate-950/20 p-2.5 rounded-xl border border-slate-800/60 space-y-1">
                    <div className="flex justify-between items-center text-[10px] text-slate-300 font-bold uppercase tracking-wider">
                      <span>Sensibilidade</span>
                      <span className="font-mono text-indigo-400">
                        {mouseSensitivity.toFixed(1)}x
                      </span>
                    </div>
                    <input 
                      id="sensitivity-range"
                      type="range"
                      min="0.5"
                      max="6.0"
                      step="0.1"
                      value={mouseSensitivity}
                      onChange={(e) => setMouseSensitivity(parseFloat(e.target.value))}
                      className="w-full accent-indigo-500 bg-slate-800 h-1 rounded-lg appearance-none cursor-pointer"
                    />
                  </div>

                  {/* TOGGLE: SOUND MUTE */}
                  <div className="bg-slate-950/20 p-2.5 rounded-xl border border-slate-800/60 flex items-center justify-between">
                    <span className="text-[10px] text-slate-350 font-bold uppercase tracking-wider">Efeitos de Som</span>
                    <button
                      id="btn-toggle-sound"
                      type="button"
                      onClick={() => setSoundMutedState(!soundMutedState)}
                      className={`px-2.5 py-1 rounded-md text-[10px] font-bold transition-all border ${
                        soundMutedState 
                          ? 'bg-rose-950/50 border-rose-500/30 text-rose-400' 
                          : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-400'
                      }`}
                    >
                      {soundMutedState ? 'MUTADO' : 'ATIVO'}
                    </button>
                  </div>

                  {/* SKIN DA ARMA */}
                  <div className="bg-slate-950/20 p-2.5 rounded-xl border border-slate-800/60 space-y-1.5">
                    <span className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block">Camuflagem da Arma</span>
                    <div className="grid grid-cols-4 gap-1">
                      {(['classic', 'gold', 'arctic', 'rust'] as const).map(sk => (
                        <button
                          key={sk}
                          type="button"
                          onClick={() => setSelectedSkin(sk)}
                          className={`py-1 rounded-md font-bold text-[9px] uppercase border transition-all ${
                            selectedSkin === sk
                              ? 'bg-indigo-600 border-indigo-400 text-white shadow'
                              : 'bg-slate-950 border-slate-800/80 text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          {sk === 'classic' ? 'Padrão' : sk === 'gold' ? 'Ouro' : sk === 'arctic' ? 'Gelo' : 'Rust'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* BOTTOM PRIMARY BUTTONS ROW */}
                <div id="esc-menu-footer" className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-800/60">
                  <button
                    id="btn-esc-leave"
                    type="button"
                    onClick={leaveGame}
                    className="bg-slate-950/50 hover:bg-rose-950/40 border border-slate-800 hover:border-rose-900/60 py-2.5 rounded-lg font-bold text-[10px] uppercase tracking-wider text-slate-400 hover:text-rose-400 transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <LogOut className="w-3 h-3" /> SAIR
                  </button>

                  <button
                    id="btn-esc-resume"
                    type="button"
                    onClick={() => {
                      safeRequestPointerLock(canvasRef.current);
                    }}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-[10px] uppercase tracking-wider py-2.5 rounded-lg transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Target className="w-3 h-3" /> RETOMAR
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* DYNAMIC COUNTDOWN SCREEN OVERLAY */}
          {countdownVal !== null && (
            <div className="absolute inset-0 bg-slate-950/85 backdrop-blur-md flex flex-col items-center justify-center z-50">
              <span className="text-[10px] uppercase tracking-widest text-slate-500 font-extrabold mb-4 animate-pulse">PREPARAR COMBATE</span>
              <div className="text-8xl font-black font-mono text-indigo-400 select-none animate-ping duration-1000">
                {countdownVal}
              </div>
            </div>
          )}

          {isNetworkRoom && roundOverlayText && countdownVal === null && !showDeathMenu && (
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center z-[45] text-center px-6">
              <div className="text-[11px] uppercase tracking-[0.35em] text-slate-400 font-black mb-4">
                Round {Math.max(1, matchState.roundNumber)}
              </div>
              <div className={`font-black select-none ${
                matchState.phase === 'countdown'
                  ? 'text-8xl font-mono text-amber-300 animate-pulse'
                  : 'text-3xl sm:text-5xl text-white uppercase tracking-widest'
              }`}>
                {roundOverlayText}
              </div>
              {roundOverlaySubtext && (
                <div className="mt-4 text-sm text-slate-400 font-bold">
                  {roundOverlaySubtext}
                </div>
              )}
              {(matchState.phase === 'waiting' || !localPlayerState?.isActive) && (
                <div className="mt-7 flex flex-col items-center gap-2">
                  <span className="text-[10px] uppercase tracking-[0.3em] text-slate-500 font-black">
                    Token para entrar
                  </span>
                  <button
                    type="button"
                    onClick={copyRoomCode}
                    className="group flex items-center gap-3 rounded-xl border border-rose-500/30 bg-rose-950/35 px-5 py-3 font-mono text-3xl sm:text-5xl font-black tracking-[0.25em] text-rose-300 shadow-xl shadow-rose-950/20 transition-all hover:border-rose-400/60 hover:bg-rose-950/55"
                    title="Copiar token da sala"
                  >
                    <span>{currentRoom}</span>
                    {copiedCode ? (
                      <Check className="h-5 w-5 text-emerald-400" />
                    ) : (
                      <Copy className="h-5 w-5 text-slate-400 transition-colors group-hover:text-white" />
                    )}
                  </button>
                  <span className="text-xs font-bold text-slate-400">
                    O outro jogador digita esse código no campo TOKEN.
                  </span>
                  <button
                    type="button"
                    onClick={leaveGame}
                    className="mt-3 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900/80 px-4 py-2 text-xs font-black uppercase tracking-widest text-slate-300 transition-all hover:border-rose-500/60 hover:bg-rose-950/35 hover:text-rose-200"
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    Desistir / Voltar
                  </button>
                </div>
              )}
              {matchState.phase === 'live' && (
                <div className="mt-5 text-5xl font-black text-emerald-400 tracking-widest">GO</div>
              )}
            </div>
          )}

          {/* HIGH-FIDELITY GAME OVER SCREEN (TRIGGERED UPON DEATH AFTER TRANSITION) */}
          {showDeathMenu && countdownVal === null && (
            <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md flex flex-col items-center justify-center p-4 text-center z-50 animate-fade-in">
              <div className="max-w-xs w-full bg-slate-900/90 border border-red-950 p-6 rounded-2xl shadow-2xl flex flex-col gap-6 items-center">
                
                {/* Visual Accent */}
                <div className="w-12 h-12 rounded-full bg-red-950/80 border border-red-500/40 flex items-center justify-center text-red-500 animate-pulse">
                  <Heart className="w-5 h-5" />
                </div>

                <div className="space-y-1">
                  <h2 className="text-xl font-black text-rose-500 uppercase tracking-widest leading-none">VOCÊ MORREU</h2>
                  <p className="text-[10px] text-slate-450 uppercase font-semibold">Tente Novamente no Campo de Batalha</p>
                </div>

                <div className="w-full space-y-2">
                  <button
                    id="btn-restart-game"
                    type="button"
                    onClick={handleRestartGameSequence}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-black text-xs uppercase tracking-widest py-3 rounded-xl transition-all duration-150 shadow-md shadow-emerald-950/20 active:scale-95 cursor-pointer"
                  >
                    REINICIAR
                  </button>

                  <button
                    id="btn-death-leave"
                    type="button"
                    onClick={leaveGame}
                    className="w-full bg-slate-950/60 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 py-2.5 rounded-xl font-black text-[10px] uppercase tracking-wider transition-all duration-150 cursor-pointer"
                  >
                    SAIR DA PARTIDA
                  </button>
                </div>

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

            {isNetworkRoom && (
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-slate-800/60 pb-2 mb-1.5">
                <div className="text-left">
                  <div className="text-[9px] uppercase tracking-widest text-blue-300 font-black">Polícia</div>
                  <div className="text-2xl font-black font-mono text-blue-400">{matchState.blueScore}</div>
                </div>
                <div className="text-[10px] text-slate-500 font-black uppercase tracking-widest">
                  R{Math.max(1, matchState.roundNumber)}
                </div>
                <div className="text-right">
                  <div className="text-[9px] uppercase tracking-widest text-red-300 font-black">Ladrão</div>
                  <div className="text-2xl font-black font-mono text-red-400">{matchState.redScore}</div>
                </div>
              </div>
            )}

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
              if (p.id === localPlayerId || !p.isActive || p.health <= 0) return null;
              
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
                    <span className="text-[8px] uppercase tracking-widest text-slate-400">
                      {p.team === 'police' ? 'Polícia' : 'Ladrão'}
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
                        <th className="pb-2.5 text-center">Time</th>
                        <th className="pb-2.5 text-center">Eliminações</th>
                        <th className="pb-2.5 text-center">Mortes</th>
                        <th className="pb-2.5 text-right pr-2">Status</th>
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
                            <td className="py-2.5 text-center font-bold">
                              <span className={p.team === 'police' ? 'text-blue-400' : p.team === 'thief' ? 'text-red-400' : 'text-slate-500'}>
                                {p.team === 'police' ? 'Polícia' : p.team === 'thief' ? 'Ladrão' : 'Fila'}
                              </span>
                            </td>
                            <td className="py-2.5 text-center text-teal-400 font-mono font-bold">{p.kills}</td>
                            <td className="py-2.5 text-center text-rose-400 font-mono font-medium">{p.deaths}</td>
                            <td className="py-2.5 text-right pr-2">
                              <span className="text-[10px] font-mono text-slate-500 uppercase">{p.isActive ? 'Ativo' : 'Aguardando'}</span>
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
