import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import './App.css';

// Ép dùng backend đúng theo môi trường (tránh cache/bundle cũ)
const HOSTNAME = window.location.hostname;
const ORIGIN = window.location.origin;
const IS_LOCAL = HOSTNAME === 'localhost' || HOSTNAME === '127.0.0.1';
// Production: dùng cùng domain đang serve app để tránh CORS/WebSocket issues
const BASE_URL = IS_LOCAL
  ? 'http://localhost:5000'
  : (process.env.REACT_APP_API_URL || ORIGIN);

const API_URL = `${BASE_URL}/api`;
const SOCKET_URL = BASE_URL;

// Log để debug - SẼ LUÔN HIỂN THỊ
console.log('🚀 ===== WEBMUSIC STARTED =====');
console.log('📍 Final API URL:', API_URL);
console.log('📍 Final Socket URL:', SOCKET_URL);
console.log('🌐 Current location:', window.location.href);
console.log('🏠 Hostname:', window.location.hostname);
console.log('================================');

function App() {
  const [roomId, setRoomId] = useState('');
  const [username, setUsername] = useState('');
  const [joined, setJoined] = useState(false);
  const [socket, setSocket] = useState(null);
  const [currentVideo, setCurrentVideo] = useState(null);
  // eslint-disable-next-line no-unused-vars
  const [isPlaying, setIsPlaying] = useState(false);
  const [queue, setQueue] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const searchInputRef = useRef(null);
  const [users, setUsers] = useState([]);
  const [player, setPlayer] = useState(null);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const chatInputRef = useRef(null);
  const getVolumeKeys = (rid) => ({
    VOLUME_KEY: `webmusic_volume_${rid || 'global'}`,
    MUTED_KEY: `webmusic_muted_${rid || 'global'}`,
  });

  const applyVolumeSettings = (target) => {
    try {
      const playerTarget = target || playerRef.current;
      if (!playerTarget) return;
      const effectiveMuted = muted || volume === 0;
      if (typeof playerTarget.setVolume === 'function') {
        playerTarget.setVolume(Math.max(0, Math.min(100, volume)));
      }
      if (effectiveMuted && typeof playerTarget.mute === 'function') {
        playerTarget.mute();
      } else if (!effectiveMuted && typeof playerTarget.unMute === 'function') {
        playerTarget.unMute();
      }
    } catch (_) {}
  };
  const playerRef = useRef(null);
  const syncIntervalRef = useRef(null);
  const isSyncingRef = useRef(false);
  const isLocalPlayRef = useRef(false);
  const isTabHiddenRef = useRef(false);
  const [showDebug, setShowDebug] = useState(false);  
  const [pendingVideo, setPendingVideo] = useState(null); // { videoId, title, thumbnail, currentTime, isPlaying }
  const lastVideoPlayAtRef = useRef(0);
  const initSyncedRef = useRef(false); // tránh load lại khi join sau
  const [leaderId, setLeaderId] = useState(null);
  const [mySocketId, setMySocketId] = useState(null);
  const mySocketIdRef = useRef(null); // Ref để lưu socket.id cho việc so sánh trong handlers
  const videoEndedEmittedRef = useRef(false); // tránh emit video-ended nhiều lần
  const lastVolumeCheckRef = useRef({ volume: 100, muted: false, lastCheck: 0 }); // để tránh volume jitter
  const volumeApplyTimeoutRef = useRef(null); // debounce cho applyVolumeSettings
  const lastSeekTimeRef = useRef(0); // để debounce seek operations
  const hasSyncedRef = useRef(false); // đánh dấu đã sync time lần đầu khi join
  const isLoadingVideoRef = useRef(false); // đánh dấu đang load video để tránh load nhiều lần
  const expectedStartTimeRef = useRef(null); // lưu expected start time để verify sau khi load
  const messagesEndRef = useRef(null);
  const audioContextRef = useRef(null);

  // Unlock AudioContext khi user tương tác với page (để bypass browser autoplay policy)
  useEffect(() => {
    const unlockAudio = () => {
      if (!audioContextRef.current) {
        try {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (AudioContextClass) {
            audioContextRef.current = new AudioContextClass();
            console.log('[AUDIO] AudioContext created and unlocked');
          }
        } catch (e) {
          console.warn('[AUDIO] Could not create AudioContext:', e);
        }
      } else if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().then(() => {
          console.log('[AUDIO] AudioContext resumed');
        }).catch((e) => {
          console.warn('[AUDIO] Could not resume AudioContext:', e);
        });
      }
    };

    // Unlock khi user click, touch, hoặc keypress (không dùng once để có thể unlock nhiều lần)
    const events = ['click', 'touchstart', 'keydown'];
    events.forEach(event => {
      document.addEventListener(event, unlockAudio);
    });

    return () => {
      events.forEach(event => {
        document.removeEventListener(event, unlockAudio);
      });
    };
  }, []);

  // Unlock AudioContext khi join room (nếu đã có user interaction trước đó)
  useEffect(() => {
    if (joined && audioContextRef.current && audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().then(() => {
        console.log('[AUDIO] AudioContext resumed after joining room');
      }).catch((e) => {
        console.warn('[AUDIO] Could not resume AudioContext after joining:', e);
      });
    }
  }, [joined]);

  // Hàm phát âm thanh thông báo khi có tin nhắn mới
  const playMessageSound = () => {
    try {
      // Sử dụng AudioContext đã được unlock
      let ctx = audioContextRef.current;
      
      // Nếu chưa có AudioContext, tạo mới
      if (!ctx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
          console.warn('[MESSAGE-SOUND] Web Audio API not supported');
          return;
        }
        ctx = new AudioContextClass();
        audioContextRef.current = ctx;
      }
      
      // Resume AudioContext nếu bị suspended
      if (ctx.state === 'suspended') {
        ctx.resume().then(() => {
          console.log('[MESSAGE-SOUND] AudioContext resumed');
          playSound(ctx);
        }).catch((e) => {
          console.warn('[MESSAGE-SOUND] Could not resume AudioContext:', e);
        });
      } else {
        playSound(ctx);
      }
      
      function playSound(audioCtx) {
        try {
          const oscillator = audioCtx.createOscillator();
          const gainNode = audioCtx.createGain();
          
          oscillator.connect(gainNode);
          gainNode.connect(audioCtx.destination);
          
          // Tạo âm thanh "ping" ngắn gọn, dễ nghe hơn
          oscillator.frequency.value = 2000; // Tần số vừa phải
          oscillator.type = 'sine';
          
          // Envelope để âm thanh mượt hơn
          gainNode.gain.setValueAtTime(0, audioCtx.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.5, audioCtx.currentTime + 0.01);
          gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.2);
          
          oscillator.start(audioCtx.currentTime);
          oscillator.stop(audioCtx.currentTime + 0.2);
          
          console.log('[MESSAGE-SOUND] ✅ Sound played successfully');
        } catch (e) {
          console.error('[MESSAGE-SOUND] Error playing sound:', e);
        }
      }
    } catch (e) {
      console.error('[MESSAGE-SOUND] Error with AudioContext:', e);
    }
  };

  useEffect(() => {
    if (messagesEndRef.current) {
      try {
        messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
      } catch (e) {
        // ignore scroll errors (e.g. element not attached)
      }
    }
  }, [messages]);

  // Helper: cố gắng autoplay với fallback mute/unmute để bypass browser autoplay policy
  const tryAutoPlay = () => {
    try {
      if (!playerRef.current) return;
      const currentMuted = muted || volume === 0;
      
      // Nếu đang unmuted, thử mute tạm thời để bypass autoplay policy
      if (!currentMuted && volume > 0) {
        playerRef.current.mute();
        playerRef.current.playVideo();
        // Unmute lại sau khi play thành công
        setTimeout(() => {
          if (playerRef.current && !currentMuted && volume > 0) {
            playerRef.current.unMute();
          }
        }, 100);
      } else {
        // Nếu đã muted hoặc volume = 0, play trực tiếp
        if (typeof playerRef.current.playVideo === 'function') {
          playerRef.current.playVideo();
        }
      }
    } catch (e) {
      console.error('[tryAutoPlay] Error:', e);
      // ignore autoplay errors; user gesture sẽ kích hoạt sau
    }
  };

  const handleVolumeInput = (e) => {
    const val = Number(e.target.value);
    // Update state: nếu volume = 0 thì mute, nếu volume > 0 thì bỏ mute
    const newMuted = val === 0;
    setVolume(val);
    if (newMuted !== muted) {
      setMuted(newMuted);
    }
    // Update lastVolumeCheckRef immediately to prevent interval from overriding
    lastVolumeCheckRef.current.volume = val;
    lastVolumeCheckRef.current.muted = newMuted;
    lastVolumeCheckRef.current.lastCheck = Date.now();
    // Apply immediately when user changes volume (no debounce)
    try {
      if (playerRef.current) {
        const effectiveMuted = val === 0;
        // Luôn unMute trước khi set volume để đảm bảo bỏ mute khi kéo lên
        if (typeof playerRef.current.unMute === 'function') {
          playerRef.current.unMute();
        }
        // Set volume
        if (typeof playerRef.current.setVolume === 'function') {
          playerRef.current.setVolume(Math.max(0, Math.min(100, val)));
        }
        // Nếu volume = 0 thì mute lại
        if (effectiveMuted && typeof playerRef.current.mute === 'function') {
          playerRef.current.mute();
        }
      }
    } catch (_) {}
  };

  const toggleMute = () => {
    try {
      if (!playerRef.current) return;
      const willMute = !muted;
      // Update state first
      setMuted(willMute);
      // Update lastVolumeCheckRef immediately to prevent interval from overriding
      lastVolumeCheckRef.current.muted = willMute || volume === 0;
      lastVolumeCheckRef.current.lastCheck = Date.now();
      // Apply immediately when user toggles mute
      const effectiveMuted = willMute || volume === 0;
      if (typeof playerRef.current.setVolume === 'function') {
        playerRef.current.setVolume(Math.max(0, Math.min(100, volume)));
      }
      if (effectiveMuted && typeof playerRef.current.mute === 'function') {
        playerRef.current.mute();
      } else if (!effectiveMuted && typeof playerRef.current.unMute === 'function') {
        playerRef.current.unMute();
      }
    } catch (_) {}
  };

  // Initialize YouTube IFrame API
  useEffect(() => {
    // Set callback for when YouTube API loads
    if (!window.onYouTubeIframeAPIReady) {
      window.onYouTubeIframeAPIReady = () => {
        console.log('YouTube IFrame API ready');
      };
    }

    // Check if already loaded
    if (window.YT && window.YT.Player) {
      console.log('YouTube IFrame API already loaded');
    }
  }, []);

  // Tất cả chức năng vẫn hoạt động khi tab hidden (video phát, sync, events, etc.)
  // Chỉ resume video khi tab visible lại nếu video bị pause bởi browser
  useEffect(() => {
    const handleVisibility = () => {
      isTabHiddenRef.current = document.hidden;
      
      if (document.hidden) {
        console.log('[VISIBILITY] Tab hidden - all functions continue to work (video, sync, events)');
        // Tất cả chức năng vẫn hoạt động bình thường khi tab hidden
      } else {
        console.log('[VISIBILITY] Tab visible - checking if video needs resume');
        if (playerRef.current) {
          try {
            const state = playerRef.current.getPlayerState();
            // Nếu video đang phát (theo state) nhưng player bị pause bởi browser, resume lại
            if (isPlaying && state !== window.YT.PlayerState.PLAYING && state !== window.YT.PlayerState.BUFFERING) {
              console.log('[VISIBILITY] Resuming video playback (was paused by browser)');
              playerRef.current.playVideo();
            }
            // Volume will be synced by the volume sync effect
          } catch (e) {
            console.error('[VISIBILITY] Error resuming video', e);
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [isPlaying]);

  // Load persisted volume/mute on mount and when room changes
  useEffect(() => {
    try {
      const { VOLUME_KEY, MUTED_KEY } = getVolumeKeys(roomId);
      const v = localStorage.getItem(VOLUME_KEY);
      const m = localStorage.getItem(MUTED_KEY);
      if (v !== null && !Number.isNaN(Number(v))) setVolume(Math.max(0, Math.min(100, Number(v))));
      if (m !== null) setMuted(m === 'true');
    } catch (_) {}
  }, [roomId]);

  // Persist volume/mute for the current room whenever they change (per-user, per-room)
  useEffect(() => {
    try {
      const { VOLUME_KEY, MUTED_KEY } = getVolumeKeys(roomId);
      localStorage.setItem(VOLUME_KEY, String(volume));
      localStorage.setItem(MUTED_KEY, String(muted));
      // Không apply volume ở đây - đã có useEffect riêng để apply khi state thay đổi
    } catch (_) {}
  }, [volume, muted, roomId]);

  // Initialize socket connection
  useEffect(() => {
    if (joined && roomId) {
      // Tính toán lại URL động để đảm bảo luôn đúng
      const currentHostname = window.location.hostname;
      const currentProtocol = window.location.protocol;
      let dynamicSocketURL = SOCKET_URL;
      
      // Nếu không phải localhost, đảm bảo dùng domain đúng
      if (currentHostname !== 'localhost' && currentHostname !== '127.0.0.1') {
        if (currentHostname === 'music.khanhcs.id.vn') {
          dynamicSocketURL = `${currentProtocol}//apimusic.khanhcs.id.vn`;
        } else if (process.env.REACT_APP_API_URL) {
          dynamicSocketURL = process.env.REACT_APP_API_URL;
        }
      }
      
      console.log('=== Socket.io Connection Debug ===');
      console.log('Current hostname:', currentHostname);
      console.log('Current protocol:', currentProtocol);
      console.log('REACT_APP_API_URL:', process.env.REACT_APP_API_URL || 'Not set');
      console.log('SOCKET_URL (static):', SOCKET_URL);
      console.log('Dynamic socket URL:', dynamicSocketURL);
      console.log('Using socket URL:', dynamicSocketURL);
      
      setMessages([]);
      setChatInput('');

      const newSocket = io(dynamicSocketURL, {
        transports: ['websocket', 'polling'], // Thử WebSocket trước, fallback về polling
        upgrade: true,
        rememberUpgrade: true,
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: 5,
        timeout: 20000,
      });
      setSocket(newSocket);
      
      // Log để debug
      console.log('Connecting to Socket.io:', SOCKET_URL);

      newSocket.on('connect', () => {
        console.log('Socket.io connected!', newSocket.id);
        const socketId = newSocket.id;
        setMySocketId(socketId);
        mySocketIdRef.current = socketId; // Lưu vào ref để dùng trong handlers (luôn có giá trị mới nhất)
        console.log('[SOCKET] Socket ID set:', socketId);
        console.log('Joining room:', roomId, 'as:', username || 'Anonymous');
        newSocket.emit('join-room', { roomId, username: username || 'Anonymous' });
        // đánh dấu cần sync lần đầu
        initSyncedRef.current = false;
      });

      newSocket.on('connect_error', (error) => {
        console.error('Socket.io connection error:', error);
        console.log('Attempting to connect to:', SOCKET_URL);
      });

      newSocket.on('disconnect', (reason) => {
        console.log('Socket.io disconnected:', reason);
      });

      newSocket.on('room-state', (state) => {
        console.log('[ROOM-STATE]', {
          hasVideo: !!state.currentVideo,
          baseTime: state.baseTime ?? state.currentTime,
          serverTs: state.serverTs,
          isPlaying: state.isPlaying,
          queueLen: (state.queue || []).length,
        });
        // Reset sync flag khi join room mới để có thể sync lại
        hasSyncedRef.current = false;
        // Reset pending video khi join room mới
        setPendingVideo(null);
        setCurrentVideo(state.currentVideo);
        setQueue(state.queue);
        setIsPlaying(state.isPlaying);
        if (state.leaderId) setLeaderId(state.leaderId);
        if (state.users) {
          setUsers(state.users);
        }
        // Tránh thao tác playback ở room-state vì ngay sau đó sẽ có video-play riêng cho socket join
        if (state.currentVideo && !playerRef.current) {
          console.log('[ROOM-STATE] player not ready -> will set pending from video-play');
          // video-play sẽ gửi currentTime đúng, nên pending sẽ được set từ video-play
          // Không cần tính ở đây
        }

        // Fallback: nếu sau một nhịp ngắn không nhận được video-play, tự load dựa trên room-state
        if (state.currentVideo) {
          const fallbackCheckTs = Date.now();
          setTimeout(() => {
            try {
              const hasRecentVideoPlay = (Date.now() - lastVideoPlayAtRef.current) < 800;
              if (hasRecentVideoPlay) return; // đã có video-play
              if (isLoadingVideoRef.current) return;
              const video = state.currentVideo;
              const base = typeof state.baseTime === 'number' ? state.baseTime : 0;
              const serverTs = state.serverTs || Date.now();
              const elapsed = Math.max(0, (Date.now() - serverTs) / 1000);
              const shouldPlay = !!state.isPlaying;
              const startSeconds = shouldPlay ? base + elapsed : base;
              console.log('[ROOM-STATE Fallback] No video-play received, loading manually', {
                since: Date.now() - fallbackCheckTs,
                startSeconds,
                base,
                elapsed,
                shouldPlay
              });
              // Mark loading to avoid races
              isLoadingVideoRef.current = true;
              setCurrentVideo({ videoId: video.videoId, title: video.title, thumbnail: video.thumbnail });
              expectedStartTimeRef.current = startSeconds;
              if (playerRef.current) {
                try {
                  playerRef.current.loadVideoById({ videoId: video.videoId, startSeconds });
                  videoEndedEmittedRef.current = false;
                  lastSeekTimeRef.current = Date.now();
                } catch (e) {
                  console.error('[ROOM-STATE Fallback] loadVideoById error', e);
                  isLoadingVideoRef.current = false;
                }
              } else {
                // Player chưa sẵn sàng: set pending để onReady xử lý
                setPendingVideo({ videoId: video.videoId, title: video.title, thumbnail: video.thumbnail, currentTime: startSeconds, isPlaying: shouldPlay, serverTs });
              }
              // Try to play if shouldPlay
              if (shouldPlay) {
                setIsPlaying(true);
                tryAutoPlay();
              } else {
                setIsPlaying(false);
              }
            } catch (e) {
              console.error('[ROOM-STATE Fallback] error', e);
            }
          }, 800);
        }
      });
      newSocket.on('leader-changed', ({ leaderId: lid }) => {
        setLeaderId(lid);
      });

      newSocket.on('users-updated', ({ users }) => {
        console.log('Users updated:', users);
        setUsers(users);
      });

      newSocket.on('chat-history', ({ messages: history }) => {
        if (Array.isArray(history)) {
          setMessages(history);
        } else {
          setMessages([]);
        }
      });

      newSocket.on('chat-message', (message) => {
        if (!message || !message.id) return;
        
        // Phát âm thanh nếu tin nhắn không phải của chính mình
        // CHỈ so sánh userId (socket.id) vì nó là unique
        // KHÔNG so sánh username vì nhiều user có thể có cùng username "Anonymous"
        // Sử dụng ref để đảm bảo so sánh với giá trị mới nhất
        const currentSocketId = mySocketIdRef.current || newSocket.id;
        const isOwnMessage = message.userId === currentSocketId;
        
        console.log('[CHAT-MESSAGE] Received message', { 
          messageId: message.id, 
          messageUserId: message.userId, 
          currentSocketId,
          mySocketIdState: mySocketId,
          username: message.username, 
          myUsername: username,
          isOwnMessage,
          socketId: newSocket.id
        });
        
        if (!isOwnMessage) {
          console.log('[CHAT-MESSAGE] ✅ Playing sound for incoming message (not own)');
          playMessageSound();
        } else {
          console.log('[CHAT-MESSAGE] ❌ Own message, skipping sound');
        }
        
        setMessages((prev) => {
          if (prev.some((msg) => msg.id === message.id)) {
            return prev;
          }
          return [...prev, message];
        });
      });

      newSocket.on('video-play', ({ videoId, title, thumbnail, currentTime, serverTs, isPlaying: serverIsPlaying }) => {
        console.log('[CLIENT] ========== VIDEO-PLAY EVENT RECEIVED ==========');
        console.log('[VIDEO-PLAY] incoming', { videoId, title, currentTime, serverTs, serverIsPlaying, localIsPlaying: isPlaying });
        // Nếu đây là play từ local (user này click "Phát ngay"), skip để tránh duplicate
        if (isLocalPlayRef.current) {
          isLocalPlayRef.current = false;
          return;
        }
        // debounce: nếu vừa xử lý video-play trong 300ms, bỏ qua để tránh reload
        // NHƯNG: Nếu videoId khác với video hiện tại, không debounce (cần load video mới ngay)
        const now = Date.now();
        const isVideoChanged = !currentVideo || currentVideo.videoId !== videoId;
        const timeSinceLastPlay = now - lastVideoPlayAtRef.current;
        if (!isVideoChanged && timeSinceLastPlay < 300) {
          console.log('[VIDEO-PLAY] debounced (same video, recent play)', { timeSinceLastPlay, videoId });
          return;
        }
        if (isVideoChanged) {
          console.log('[VIDEO-PLAY] Video changed, skipping debounce', { oldVideoId: currentVideo?.videoId, newVideoId: videoId });
        }
        lastVideoPlayAtRef.current = now;
        
        // Lấy isPlaying từ server (đáng tin cậy hơn) hoặc từ state hiện tại
        const shouldPlay = serverIsPlaying !== undefined ? serverIsPlaying : isPlaying;
        // Cập nhật state để đồng bộ
        if (serverIsPlaying !== undefined && serverIsPlaying !== isPlaying) {
          setIsPlaying(serverIsPlaying);
        }
        
        // Nếu player chưa sẵn sàng, lưu pending để phát ngay khi onReady
        if (!playerRef.current) {
          console.log('[VIDEO-PLAY] player not ready -> pending', { shouldPlay, serverIsPlaying });
          // Cập nhật isPlaying state ngay khi nhận video-play
          if (shouldPlay) {
            setIsPlaying(true);
          }
          setPendingVideo({ videoId, title, thumbnail, currentTime: currentTime || 0, isPlaying: shouldPlay, serverTs: serverTs || null });
        } else {
          // Kiểm tra video đã load chưa
          let loadedId = null;
          let currentState = null;
          try {
            const vd = playerRef.current.getVideoData && playerRef.current.getVideoData();
            loadedId = vd && vd.video_id ? vd.video_id : null;
            currentState = playerRef.current.getPlayerState ? playerRef.current.getPlayerState() : null;
          } catch (e) {}
          
          // Kiểm tra xem videoId có khác với video hiện tại trong state không
          const isVideoChanged = !currentVideo || currentVideo.videoId !== videoId;
          
          // Load lại video nếu:
          // 1. Video khác với video hiện tại trong state (luôn load video mới)
          // 2. Video khác với video đã load trong player
          // 3. Hoặc chưa sync (hasSyncedRef = false) - đây là user mới join
          // 4. Hoặc player đang ở state ENDED (cần load video mới)
          const shouldLoad = isVideoChanged || !loadedId || loadedId !== videoId || !hasSyncedRef.current || currentState === window.YT.PlayerState.ENDED;
          
          console.log('[VIDEO-PLAY] Checking if should load', { 
            currentVideoId: currentVideo?.videoId, 
            newVideoId: videoId, 
            loadedId, 
            isVideoChanged,
            shouldLoad, 
            isLoadingVideo: isLoadingVideoRef.current, 
            hasSynced: hasSyncedRef.current, 
            currentState 
          });
          
          // Nếu video khác hoặc player đang ở state ENDED, reset tất cả flags để có thể load video mới
          if (isVideoChanged || (loadedId && loadedId !== videoId) || currentState === window.YT.PlayerState.ENDED) {
            console.log('[VIDEO-PLAY] Video changed or player ended, resetting all flags', { 
              isVideoChanged, 
              loadedId, 
              videoId, 
              currentState,
              currentVideoId: currentVideo?.videoId 
            });
            isLoadingVideoRef.current = false;
            hasSyncedRef.current = false;
            expectedStartTimeRef.current = null;
            videoEndedEmittedRef.current = false;
          }
          
          // Tránh load video nhiều lần cùng lúc (chỉ skip nếu đang load cùng video)
          if (isLoadingVideoRef.current && shouldLoad && loadedId === videoId) {
            console.log('[VIDEO-PLAY] Video đang được load (same video), bỏ qua request này');
            return;
          }
          
          if (shouldLoad) {
            setCurrentVideo({ videoId, title, thumbnail });
            // Reset sync flag khi video mới được play để có thể sync lại
            hasSyncedRef.current = false;
            // Đánh dấu đang load video để tránh load nhiều lần
            isLoadingVideoRef.current = true;
            
            // Tính startSeconds chính xác: currentTime từ server là liveTime của leader tại serverTs
            // Cần cộng thêm thời gian đã trôi qua từ serverTs đến khi client load video
            const start = (() => {
              const base = currentTime || 0; // currentTime từ server = liveTime của leader tại serverTs
              // Tính thời gian đã trôi qua từ khi server gửi đến khi client load video
              const elapsed = serverTs ? Math.max(0, (Date.now() - serverTs) / 1000) : 0;
              // Nếu đang playing (từ shouldPlay), cộng thêm elapsed time để có thời gian hiện tại
              const calculated = shouldPlay ? base + elapsed : base;
              console.log('[VIDEO-PLAY] Calculating startSeconds from leader currentTime', { 
                base, // currentTime từ leader
                serverTs, 
                elapsed, 
                calculated, 
                now: Date.now(), 
                shouldPlay,
                note: 'base = leader currentTime at serverTs, calculated = base + elapsed if playing'
              });
              return calculated;
            })();
            
            console.log('[VIDEO-PLAY] Loading video with startSeconds', start, 'leader currentTime:', currentTime, 'serverTs:', serverTs, 'shouldPlay:', shouldPlay, 'loadedId:', loadedId, 'hasSynced:', hasSyncedRef.current);
            
            // Load video với startSeconds đã tính, chỉ load một lần duy nhất
            try {
              console.log('[VIDEO-PLAY] ✅ Calling loadVideoById with', { videoId, title, startSeconds: start, shouldPlay, serverIsPlaying });
              // Lưu expected time để verify sau khi load
              expectedStartTimeRef.current = start;
              playerRef.current.loadVideoById({ videoId, startSeconds: start });
              console.log('[VIDEO-PLAY] ✅ loadVideoById called successfully');
              initSyncedRef.current = true;
              videoEndedEmittedRef.current = false; // Reset flag when loading new video
              lastSeekTimeRef.current = Date.now(); // Đánh dấu đã seek để tránh seek lại
              
              // Verify và seek lại nếu video load sai vị trí
              const verifyAndSeek = (attemptNum) => {
                setTimeout(() => {
                  try {
                    if (playerRef.current && playerRef.current.getCurrentTime && expectedStartTimeRef.current !== null) {
                      const loadedTime = playerRef.current.getCurrentTime();
                      const expected = expectedStartTimeRef.current;
                      const diff = Math.abs(loadedTime - expected);
                      console.log(`[VIDEO-PLAY] Verify attempt ${attemptNum}: loaded time:`, loadedTime, 'expected:', expected, 'diff:', diff);
                      
                      // Nếu video load sai vị trí (sai > 1s), seek lại
                      if (diff > 1 && attemptNum < 3) {
                        console.log(`[VIDEO-PLAY] Video loaded at wrong position (diff: ${diff}s), seeking to correct time:`, expected);
                        playerRef.current.seekTo(expected, true);
                        // Verify lại sau khi seek
                        verifyAndSeek(attemptNum + 1);
                      } else if (diff <= 1) {
                        console.log(`[VIDEO-PLAY] Video loaded at correct position`);
                        expectedStartTimeRef.current = null; // Reset sau khi verify xong
                      }
                    }
                  } catch (e) {
                    console.error(`[VIDEO-PLAY] Error verifying loaded time (attempt ${attemptNum})`, e);
                  }
                }, 300 * attemptNum); // Tăng delay cho mỗi attempt
              };
              verifyAndSeek(1); // Verify lần đầu sau 300ms
              verifyAndSeek(2); // Verify lần 2 sau 600ms
              verifyAndSeek(3); // Verify lần 3 sau 900ms
              
              // Đánh dấu đã sync ngay sau khi load để không sync lại
              hasSyncedRef.current = true;
              
              // Reset loading flag sau khi video load xong (trong onStateChange)
              // Không apply volume ở đây - để user tự điều chỉnh qua button
              // Không seek lại nữa - chỉ load một lần với startSeconds đúng
              
              // Tự động play nếu cần, nhưng chỉ sau khi video đã load xong (CUED state)
              if (shouldPlay) {
                setIsPlaying(true);
                console.log('[VIDEO-PLAY] Setting isPlaying=true, will attempt to play after video loads');
                // Thử play nhiều lần với delay khác nhau, nhưng chỉ khi video đã ở CUED state
                const attemptPlay = (delay, attemptNum) => {
                  setTimeout(() => {
                    try {
                      if (!playerRef.current) {
                        console.log(`[VIDEO-PLAY] Attempt ${attemptNum}: player not ready`);
                        return;
                      }
                      const state = playerRef.current.getPlayerState ? playerRef.current.getPlayerState() : -1;
                      console.log(`[VIDEO-PLAY] Attempt ${attemptNum} to play (${delay}ms)`, { state, shouldPlay, isPlaying });
                      
                      if (state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.BUFFERING) {
                        // Đã đang playing, không cần làm gì
                        console.log(`[VIDEO-PLAY] Attempt ${attemptNum}: Already playing/buffering`);
                        isLoadingVideoRef.current = false; // Reset flag
                        return;
                      }
                      
                      // Play khi video đã ở CUED state (đã load xong) hoặc UNSTARTED (có thể play được)
                      if (state === window.YT.PlayerState.CUED || state === window.YT.PlayerState.UNSTARTED) {
                        console.log(`[VIDEO-PLAY] Attempt ${attemptNum}: Video ready (${state}), auto-playing`);
                        isLoadingVideoRef.current = false; // Reset flag
                        // Thử mute tạm thời để bypass autoplay policy
                        const currentMuted = muted || volume === 0;
                        if (!currentMuted && volume > 0) {
                          playerRef.current.mute();
                          playerRef.current.playVideo();
                          console.log('[VIDEO-PLAY] Muted and playing, will unmute after 200ms');
                          // Unmute lại sau khi play thành công
                          setTimeout(() => {
                            if (playerRef.current && !currentMuted && volume > 0) {
                              playerRef.current.unMute();
                              console.log('[VIDEO-PLAY] Unmuted after successful play');
                            }
                          }, 200);
                        } else {
                          playerRef.current.playVideo();
                          console.log('[VIDEO-PLAY] Playing directly (already muted or volume=0)');
                        }
                      } else if (state === window.YT.PlayerState.PAUSED) {
                        // Video đang paused, thử play
                        console.log(`[VIDEO-PLAY] Attempt ${attemptNum}: Video paused, attempting to play`);
                        isLoadingVideoRef.current = false; // Reset flag
                        const currentMuted = muted || volume === 0;
                        if (!currentMuted && volume > 0) {
                          playerRef.current.mute();
                          playerRef.current.playVideo();
                          setTimeout(() => {
                            if (playerRef.current && !currentMuted && volume > 0) {
                              playerRef.current.unMute();
                            }
                          }, 200);
                        } else {
                          playerRef.current.playVideo();
                        }
                      } else {
                        // Video chưa load xong hoặc state khác (BUFFERING, ENDED, etc.)
                        console.log(`[VIDEO-PLAY] Attempt ${attemptNum}: Video not ready yet (state: ${state}), will retry`);
                        if (attemptNum < 4) {
                          // Chưa hết attempts, sẽ retry ở lần sau
                          return;
                        }
                        // Hết attempts, reset flag
                        isLoadingVideoRef.current = false;
                      }
                    } catch (e) {
                      console.error(`[VIDEO-PLAY] Attempt ${attemptNum}: Error playing video`, e);
                      if (attemptNum >= 4) {
                        isLoadingVideoRef.current = false; // Reset flag nếu có lỗi
                      }
                    }
                  }, delay);
                };
                // Thử play tại 500ms, 1000ms, 2000ms, 3000ms để đảm bảo video đã load xong (giảm delay để nhanh hơn)
                attemptPlay(500, 1);
                attemptPlay(1000, 2);
                attemptPlay(2000, 3);
                attemptPlay(3000, 4);
              } else {
                setIsPlaying(false);
                isLoadingVideoRef.current = false; // Reset flag
                console.log('[VIDEO-PLAY] shouldPlay=false, not auto-playing');
              }
            } catch (e) {
              console.error('[VIDEO-PLAY] Error loading video', e);
              isLoadingVideoRef.current = false; // Reset flag nếu có lỗi
            }
          } else {
            // Đã cùng video và đã sync, chỉ cập nhật playing state
            console.log('[VIDEO-PLAY] Video already loaded and synced, updating playing state only', { shouldPlay, loadedId, videoId });
            if (shouldPlay) {
              setIsPlaying(true);
              tryAutoPlay();
            } else {
              setIsPlaying(false);
            }
          }
        }
        console.log('[CLIENT] ===========================================');
      });

      newSocket.on('video-pause', () => {
        setIsPlaying(false);
        if (playerRef.current) {
          playerRef.current.pauseVideo();
        }
      });

      newSocket.on('video-resume', () => {
        setIsPlaying(true);
        if (playerRef.current) {
          playerRef.current.playVideo();
          // Volume will be synced by the volume sync effect
        }
      });

      newSocket.on('video-seek', ({ time }) => {
        if (playerRef.current && !isSyncingRef.current) {
          playerRef.current.seekTo(time, true);
        }
      });

      newSocket.on('queue-updated', ({ queue }) => {
        setQueue(queue);
      });

      return () => {
        newSocket.close();
      };
    }
  }, [joined, roomId, username]);

  // Initialize YouTube Player
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (joined && window.YT && window.YT.Player && !playerRef.current) {
      // eslint-disable-next-line no-unused-vars
      // Calculate height based on container width for 16:9 aspect ratio
      const containerWidth = document.querySelector('.player-wrapper')?.offsetWidth || 640;
      const playerHeight = Math.round(containerWidth * 0.5625); // 16:9 ratio
      
      const ytPlayer = new window.YT.Player('youtube-player', {
        height: playerHeight.toString(),
        width: '100%',
        playerVars: {
          autoplay: 0,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            playerRef.current = event.target;
            setPlayer(event.target);
            console.log('YouTube Player ready');
            try { applyVolumeSettings(event.target); } catch (_) {}
            
            // Request sync một lần khi player ready (chỉ nếu chưa sync)
            if (socket && !hasSyncedRef.current) {
              socket.emit('sync-request', { roomId });
            }

            // Nếu có pending video do nhận event trước khi player sẵn sàng
            if (pendingVideo) {
              console.log('[ONREADY] Processing pending video', { pendingVideo });
              // Tránh load video nhiều lần cùng lúc
              if (isLoadingVideoRef.current) {
                console.log('[ONREADY] Video đang được load, bỏ qua pending video');
                return;
              }
              
              const { videoId, title, thumbnail, currentTime, isPlaying: shouldPlay, serverTs } = pendingVideo;
              // Tính lại startSeconds chính xác tại thời điểm player ready
              // currentTime từ server là liveTime của leader tại serverTs
              // Cần cộng thêm thời gian đã trôi qua từ serverTs đến khi player ready
              const start = (() => {
                const base = currentTime || 0; // currentTime từ server = liveTime của leader tại serverTs
                // Tính thời gian đã trôi qua từ khi server gửi đến khi player ready
                const elapsed = serverTs ? Math.max(0, (Date.now() - serverTs) / 1000) : 0;
                // Nếu đang playing, cộng thêm elapsed time để có thời gian hiện tại
                const calculated = shouldPlay ? base + elapsed : base;
                console.log('[ONREADY] Calculating startSeconds from leader currentTime for pending', { 
                  base, // currentTime từ leader
                  serverTs, 
                  elapsed, 
                  calculated, 
                  now: Date.now(),
                  shouldPlay,
                  note: 'base = leader currentTime at serverTs, calculated = base + elapsed if playing'
                });
                return calculated;
              })();
              
              setCurrentVideo({ videoId, title, thumbnail });
              // Reset sync flag khi load pending video để có thể sync lại
              hasSyncedRef.current = false;
              // Đánh dấu đang load video để tránh load nhiều lần
              isLoadingVideoRef.current = true;
              
              console.log('[ONREADY] Loading pending video with startSeconds', start, 'currentTime:', currentTime, 'serverTs:', serverTs, 'shouldPlay:', shouldPlay);
              
              // Load video với startSeconds đã tính, chỉ load một lần duy nhất
              try {
                console.log('[ONREADY] Calling loadVideoById with', { videoId, startSeconds: start, calculated: start });
                // Lưu expected time để verify sau khi load
                expectedStartTimeRef.current = start;
                event.target.loadVideoById({ videoId, startSeconds: start });
                videoEndedEmittedRef.current = false; // Reset flag when loading new video
                lastSeekTimeRef.current = Date.now(); // Đánh dấu đã seek để tránh seek lại
                
                // Verify và seek lại nếu video load sai vị trí
                const verifyAndSeek = (attemptNum) => {
                  setTimeout(() => {
                    try {
                      if (event.target && event.target.getCurrentTime && expectedStartTimeRef.current !== null) {
                        const loadedTime = event.target.getCurrentTime();
                        const expected = expectedStartTimeRef.current;
                        const diff = Math.abs(loadedTime - expected);
                        console.log(`[ONREADY] Verify attempt ${attemptNum}: loaded time:`, loadedTime, 'expected:', expected, 'diff:', diff);
                        
                        // Nếu video load sai vị trí (sai > 1s), seek lại
                        if (diff > 1 && attemptNum < 3) {
                          console.log(`[ONREADY] Video loaded at wrong position (diff: ${diff}s), seeking to correct time:`, expected);
                          event.target.seekTo(expected, true);
                          // Verify lại sau khi seek
                          verifyAndSeek(attemptNum + 1);
                        } else if (diff <= 1) {
                          console.log(`[ONREADY] Video loaded at correct position`);
                          expectedStartTimeRef.current = null; // Reset sau khi verify xong
                        }
                      }
                    } catch (e) {
                      console.error(`[ONREADY] Error verifying loaded time (attempt ${attemptNum})`, e);
                    }
                  }, 300 * attemptNum); // Tăng delay cho mỗi attempt
                };
                verifyAndSeek(1); // Verify lần đầu sau 300ms
                verifyAndSeek(2); // Verify lần 2 sau 600ms
                verifyAndSeek(3); // Verify lần 3 sau 900ms
                
                // Đánh dấu đã sync ngay sau khi load để không sync lại
                hasSyncedRef.current = true;
                
                // Không apply volume ở đây - để user tự điều chỉnh qua button
                setPendingVideo(null);
                initSyncedRef.current = true;
                
                // Tự động play nếu cần, nhưng chỉ sau khi video đã load xong (CUED state)
                if (shouldPlay) {
                  setIsPlaying(true);
                  console.log('[ONREADY] Setting isPlaying=true, will attempt to play after video loads', { shouldPlay, pendingVideo });
                  // Lưu shouldPlay vào ref để có thể sử dụng trong onStateChange
                  const shouldPlayRef = { value: shouldPlay };
                  // Thử play nhiều lần với delay khác nhau, sử dụng shouldPlay từ closure
                  const attemptPlay = (delay, attemptNum) => {
                    setTimeout(() => {
                      try {
                        if (!event.target) {
                          console.log(`[ONREADY] Attempt ${attemptNum}: player not ready`);
                          return;
                        }
                        const state = event.target.getPlayerState ? event.target.getPlayerState() : -1;
                        console.log(`[ONREADY] Attempt ${attemptNum} to play (${delay}ms)`, { state, shouldPlay: shouldPlayRef.value, isPlaying });
                        
                        if (state === window.YT.PlayerState.PLAYING || state === window.YT.PlayerState.BUFFERING) {
                          // Đã đang playing, không cần làm gì
                          console.log(`[ONREADY] Attempt ${attemptNum}: Already playing/buffering`);
                          isLoadingVideoRef.current = false; // Reset flag
                          shouldPlayRef.value = false; // Đã play xong, không cần play nữa
                          return;
                        }
                        
                        // Play khi video đã ở CUED state (đã load xong) hoặc UNSTARTED (có thể play được)
                        if (state === window.YT.PlayerState.CUED || state === window.YT.PlayerState.UNSTARTED) {
                          console.log(`[ONREADY] Attempt ${attemptNum}: Video ready (${state}), auto-playing with shouldPlay=${shouldPlayRef.value}`);
                          isLoadingVideoRef.current = false; // Reset flag
                          shouldPlayRef.value = false; // Đã play xong, không cần play nữa
                          // Thử mute tạm thời để bypass autoplay policy
                          const currentMuted = muted || volume === 0;
                          if (!currentMuted && volume > 0) {
                            event.target.mute();
                            event.target.playVideo();
                            console.log('[ONREADY] Muted and playing, will unmute after 200ms');
                            // Unmute lại sau khi play thành công
                            setTimeout(() => {
                              if (event.target && !currentMuted && volume > 0) {
                                event.target.unMute();
                                console.log('[ONREADY] Unmuted after successful play');
                              }
                            }, 200);
                          } else {
                            event.target.playVideo();
                            console.log('[ONREADY] Playing directly (already muted or volume=0)');
                          }
                        } else if (state === window.YT.PlayerState.PAUSED) {
                          // Video đang paused, thử play
                          console.log(`[ONREADY] Attempt ${attemptNum}: Video paused, attempting to play`);
                          isLoadingVideoRef.current = false; // Reset flag
                          shouldPlayRef.value = false; // Đã play xong, không cần play nữa
                          const currentMuted = muted || volume === 0;
                          if (!currentMuted && volume > 0) {
                            event.target.mute();
                            event.target.playVideo();
                            setTimeout(() => {
                              if (event.target && !currentMuted && volume > 0) {
                                event.target.unMute();
                              }
                            }, 200);
                          } else {
                            event.target.playVideo();
                          }
                        } else {
                          // Video chưa load xong
                          console.log(`[ONREADY] Attempt ${attemptNum}: Video not ready yet (state: ${state}), will retry`);
                          if (attemptNum < 4) {
                            return; // Sẽ retry ở lần sau
                          }
                          isLoadingVideoRef.current = false; // Reset flag sau lần attempt cuối
                          // Nếu hết attempts mà vẫn chưa play, giữ shouldPlayRef để có thể play trong onStateChange
                        }
                      } catch (e) {
                        console.error(`[ONREADY] Attempt ${attemptNum}: Error playing video`, e);
                        if (attemptNum >= 4) {
                          isLoadingVideoRef.current = false; // Reset flag nếu có lỗi
                        }
                      }
                    }, delay);
                  };
                  // Thử play tại 500ms, 1000ms, 2000ms, 3000ms để đảm bảo video đã load xong (giảm delay để nhanh hơn)
                  attemptPlay(500, 1);
                  attemptPlay(1000, 2);
                  attemptPlay(2000, 3);
                  attemptPlay(3000, 4);
                } else {
                  setIsPlaying(false);
                  isLoadingVideoRef.current = false; // Reset flag
                  console.log('[ONREADY] shouldPlay=false, not auto-playing');
                }
              } catch (e) {
                console.error('[ONREADY] Error loading pending video', e);
                isLoadingVideoRef.current = false; // Reset flag nếu có lỗi
              }
            }
          },
          onError: (e) => {
            try {
              // Fallback: cue rồi play
              if (currentVideo && playerRef.current) {
                const vid = currentVideo.videoId;
                playerRef.current.cueVideoById({ videoId: vid });
                setTimeout(() => tryAutoPlay(), 300);
              }
            } catch (_) {}
          },
          onStateChange: (event) => {
            // Log tất cả state changes để debug
            const stateNames = {
              [window.YT.PlayerState.ENDED]: 'ENDED',
              [window.YT.PlayerState.PLAYING]: 'PLAYING',
              [window.YT.PlayerState.PAUSED]: 'PAUSED',
              [window.YT.PlayerState.BUFFERING]: 'BUFFERING',
              [window.YT.PlayerState.CUED]: 'CUED',
              [window.YT.PlayerState.UNSTARTED]: 'UNSTARTED'
            };
            console.log('[ONSTATECHANGE] State changed:', stateNames[event.data] || 'UNKNOWN', event.data, { 
              videoId: currentVideo?.videoId,
              isPlaying,
              isLeader: mySocketId === leaderId
            });
            
            if (event.data === window.YT.PlayerState.PLAYING) {
              setIsPlaying(true);
              videoEndedEmittedRef.current = false; // Reset flag when new video starts playing
              isLoadingVideoRef.current = false; // Reset loading flag khi video đã playing
              // Luôn emit resume-video để sync với server, kể cả khi tab hidden
              if (socket && !isSyncingRef.current) {
                socket.emit('resume-video', { roomId });
              }
              // Volume will be synced by the volume sync effect, no need to apply here
            } else if (event.data === window.YT.PlayerState.UNSTARTED) {
              // Video mới được load (thường xảy ra sau khi video cũ kết thúc)
              console.log('[ONSTATECHANGE] Video UNSTARTED (new video loaded)', { isPlaying });
              videoEndedEmittedRef.current = false;
              // Nếu isPlaying = true, tự động play video mới
              if (isPlaying && playerRef.current) {
                setTimeout(() => {
                  try {
                    if (playerRef.current) {
                      const state = playerRef.current.getPlayerState ? playerRef.current.getPlayerState() : -1;
                      if (state === window.YT.PlayerState.UNSTARTED || state === window.YT.PlayerState.CUED) {
                        console.log('[ONSTATECHANGE] UNSTARTED - auto-playing new video', { state, isPlaying });
                        isLoadingVideoRef.current = false;
                        const currentMuted = muted || volume === 0;
                        if (!currentMuted && volume > 0) {
                          playerRef.current.mute();
                          playerRef.current.playVideo();
                          setTimeout(() => {
                            if (playerRef.current && !currentMuted && volume > 0) {
                              playerRef.current.unMute();
                            }
                          }, 200);
                        } else {
                          playerRef.current.playVideo();
                        }
                      }
                    }
                  } catch (e) {
                    console.error('[ONSTATECHANGE] Error playing video in UNSTARTED', e);
                  }
                }, 100);
              }
            } else if (event.data === window.YT.PlayerState.BUFFERING || event.data === window.YT.PlayerState.CUED) {
              // Reset flag when new video is loading
              videoEndedEmittedRef.current = false;
              
              // Reset loading flag khi video đã load xong (CUED state)
              if (event.data === window.YT.PlayerState.CUED) {
                isLoadingVideoRef.current = false;
                console.log('[ONSTATECHANGE] Video loaded (CUED), reset loading flag', { isPlaying });
                
                // Kiểm tra và seek lại nếu video load sai vị trí
                if (expectedStartTimeRef.current !== null && playerRef.current) {
                  setTimeout(() => {
                    try {
                      if (playerRef.current && playerRef.current.getCurrentTime) {
                        const currentTime = playerRef.current.getCurrentTime();
                        const expected = expectedStartTimeRef.current;
                        const diff = Math.abs(currentTime - expected);
                        console.log('[ONSTATECHANGE] CUED - verifying position', { currentTime, expected, diff });
                        
                        if (diff > 1) {
                          console.log('[ONSTATECHANGE] CUED - video at wrong position, seeking to:', expected);
                          playerRef.current.seekTo(expected, true);
                          expectedStartTimeRef.current = null; // Reset sau khi seek
                        } else {
                          console.log('[ONSTATECHANGE] CUED - video at correct position');
                          expectedStartTimeRef.current = null; // Reset sau khi verify
                        }
                      }
                    } catch (e) {
                      console.error('[ONSTATECHANGE] Error verifying position in CUED', e);
                    }
                  }, 200);
                }
                
                // Nếu video đã load xong và isPlaying = true, tự động play
                // Đây là fallback cho trường hợp attemptPlay trong onReady không thành công
                // Sử dụng cả state và một timeout để đảm bảo play
                if (isPlaying && playerRef.current) {
                  setTimeout(() => {
                    try {
                      if (playerRef.current) {
                        const state = playerRef.current.getPlayerState ? playerRef.current.getPlayerState() : -1;
                        const currentIsPlaying = isPlaying; // Capture current state
                        console.log('[ONSTATECHANGE] CUED state - checking if should play', { state, currentIsPlaying, isLoadingVideo: isLoadingVideoRef.current });
                        
                        // Chỉ play nếu video đang ở CUED state và isPlaying = true và chưa đang loading
                        // Cho phép play ngay cả khi đang loading để đảm bảo user mới join được play
                        if (state === window.YT.PlayerState.CUED && currentIsPlaying) {
                          console.log('[ONSTATECHANGE] Auto-playing video after CUED (fallback)', { state, currentIsPlaying, isLoadingVideo: isLoadingVideoRef.current });
                          // Reset loading flag khi bắt đầu play
                          isLoadingVideoRef.current = false;
                          // Thử mute tạm thời để bypass autoplay policy
                          const currentMuted = muted || volume === 0;
                          if (!currentMuted && volume > 0) {
                            playerRef.current.mute();
                            playerRef.current.playVideo();
                            // Unmute lại sau khi play thành công
                            setTimeout(() => {
                              if (playerRef.current && !currentMuted && volume > 0) {
                                playerRef.current.unMute();
                                console.log('[ONSTATECHANGE] Unmuted after successful play');
                              }
                            }, 200);
                          } else {
                            playerRef.current.playVideo();
                            console.log('[ONSTATECHANGE] Playing directly (already muted or volume=0)');
                          }
                        } else if (state === window.YT.PlayerState.CUED && !currentIsPlaying) {
                          console.log('[ONSTATECHANGE] Video CUED but isPlaying=false, not playing');
                        }
                      }
                    } catch (e) {
                      console.error('[ONSTATECHANGE] Error playing video', e);
                    }
                  }, 300); // Giảm delay xuống 300ms để nhanh hơn
                } else {
                  console.log('[ONSTATECHANGE] Video CUED but isPlaying=false or player not ready', { isPlaying, hasPlayer: !!playerRef.current });
                }
              }
              // Volume will be synced by the volume sync effect, no need to apply here
              // Không cần sync-request nữa - đã sync một lần khi join hoặc khi video-play
            } else if (event.data === window.YT.PlayerState.PAUSED) {
              // Luôn emit pause-video để sync với server, kể cả khi tab hidden
              setIsPlaying(false);
              if (socket && !isSyncingRef.current) {
                socket.emit('pause-video', { roomId });
              }
            } else if (event.data === window.YT.PlayerState.ENDED) {
              // Chỉ leader thông báo video-ended để server quyết định next
              console.log('[CLIENT] ========== VIDEO-ENDED STATE ==========');
              try {
                // Ngăn video tự động loop lại - dừng video ngay khi kết thúc
                if (playerRef.current && playerRef.current.stopVideo) {
                  try {
                    playerRef.current.stopVideo();
                    console.log('[VIDEO-ENDED] Stopped video to prevent auto-loop');
                  } catch (e) {
                    console.warn('[VIDEO-ENDED] Error stopping video', e);
                  }
                }
                
                let currentTime = 0;
                let duration = 0;
                try {
                  if (playerRef.current?.getCurrentTime) {
                    const ct = playerRef.current.getCurrentTime();
                    currentTime = typeof ct === 'number' && !isNaN(ct) ? ct : 0;
                  }
                  if (playerRef.current?.getDuration) {
                    const dur = playerRef.current.getDuration();
                    duration = typeof dur === 'number' && !isNaN(dur) ? dur : 0;
                  }
                } catch (e) {
                  console.warn('[VIDEO-ENDED] Error getting video time info:', e);
                }
                console.log('[VIDEO-ENDED] 🎬 PLAYER STATE ENDED!', { 
                  videoId: currentVideo?.videoId, 
                  title: currentVideo?.title,
                  currentTime: currentTime.toFixed(2), 
                  duration: duration.toFixed(2),
                  mySocketId, 
                  leaderId, 
                  isLeader: mySocketId === leaderId, 
                  alreadyEmitted: videoEndedEmittedRef.current,
                  queueLength: queue.length,
                  queueVideos: queue.map(v => ({ id: v.videoId, title: v.title }))
                });
                if (socket && mySocketId && leaderId && mySocketId === leaderId && !videoEndedEmittedRef.current) {
                  console.log('[VIDEO-ENDED] ✅ Emitting video-ended to server, roomId:', roomId);
                  videoEndedEmittedRef.current = true;
                  socket.emit('video-ended', { roomId });
                  console.log('[VIDEO-ENDED] ✅ video-ended event emitted');
                } else {
                  console.log('[VIDEO-ENDED] ❌ Not leader or already emitted, skipping', { 
                    hasSocket: !!socket, 
                    mySocketId, 
                    leaderId, 
                    isLeader: mySocketId === leaderId, 
                    alreadyEmitted: videoEndedEmittedRef.current 
                  });
                }
              } catch (e) {
                console.error('[VIDEO-ENDED] Error getting video info', e);
              }
              console.log('[CLIENT] ===========================================');
            }
          },
        },
      });
    }
  }, [joined, socket, roomId, pendingVideo, queue.length, volume, muted, mySocketId, leaderId]);

  // Sync time updates - Leader gửi time-update đều đặn để server biết thời gian hiện tại
  useEffect(() => {
    if (player && socket && joined && !isSyncingRef.current && mySocketId && leaderId && mySocketId === leaderId && isPlaying) {
      // Leader gửi time-update mỗi 500ms để sync chính xác hơn
      syncIntervalRef.current = setInterval(() => {
        try {
          if (playerRef.current && playerRef.current.getCurrentTime) {
            const currentTime = playerRef.current.getCurrentTime();
            if (typeof currentTime === 'number' && !isNaN(currentTime) && currentTime >= 0) {
              socket.emit('time-update', { roomId, time: currentTime });
            }
          }
        } catch (e) {
          console.error('[LEADER] Error getting current time', e);
        }
      }, 500); // Gửi mỗi 500ms để sync chính xác hơn
    }

    return () => {
      if (syncIntervalRef.current) {
        clearInterval(syncIntervalRef.current);
        syncIntervalRef.current = null;
      }
    };
  }, [player, socket, joined, roomId, mySocketId, leaderId, isPlaying]);

  // Socket sync response handler
  useEffect(() => {
    if (socket) {
      socket.on('sync-response', ({ currentVideo: srvVideo, baseTime, serverTs, isPlaying }) => {
        if (srvVideo && playerRef.current) {
          let loadedId = null;
          try {
            const getDataFn = playerRef.current.getVideoData;
            const data = typeof getDataFn === 'function' ? getDataFn.call(playerRef.current) : null;
            loadedId = data && data.video_id ? data.video_id : null;
          } catch (e) {
            loadedId = null;
          }
          const targetId = srvVideo.videoId;
          const currentStateId = (typeof currentVideo === 'object' && currentVideo && currentVideo.videoId) ? currentVideo.videoId : null;
          
          // Check if video is ready (can get current time)
          let localTime = null;
          let playerState = -1;
          try {
            if (playerRef.current.getCurrentTime) {
              const time = playerRef.current.getCurrentTime();
              if (typeof time === 'number' && !isNaN(time) && time >= 0) {
                localTime = time;
              }
            }
            if (playerRef.current.getPlayerState) {
              playerState = playerRef.current.getPlayerState();
            }
          } catch (e) {
            console.log('[SYNC-RESPONSE] Error getting player state/time', e);
          }
          
          // Calculate server time
          const serverTime = (() => {
            const base = baseTime ?? 0;
            // baseTime từ server đã là live time tại serverTs, chỉ cần bù latency
            const latency = serverTs ? Math.max(0, (Date.now() - serverTs) / 1000) : 0;
            return isPlaying ? base + latency : base;
          })();
          
          // If localTime is not available, assume we need to seek (video just loaded or not ready)
          const diff = localTime !== null ? Math.abs(localTime - serverTime) : Infinity;
          console.log('[SYNC-RESPONSE]', { localTime, serverTime, diff, baseTime, serverTs, isPlaying, playerState, loadedId, targetId });

          isSyncingRef.current = true;
          // Chỉ sync một lần khi join, sau đó không sync nữa
          if (hasSyncedRef.current) {
            console.log('[SYNC-RESPONSE] Already synced, skipping');
            return;
          }
          
          // Chỉ reload video nếu khác videoId
          if (loadedId && loadedId !== targetId) {
            setCurrentVideo(srvVideo);
            playerRef.current.loadVideoById({ videoId: targetId, startSeconds: serverTime });
            lastSeekTimeRef.current = Date.now();
            hasSyncedRef.current = true; // Đánh dấu đã sync
          } else if (!loadedId && currentStateId && currentStateId !== targetId) {
            setCurrentVideo(srvVideo);
            playerRef.current.loadVideoById({ videoId: targetId, startSeconds: serverTime });
            lastSeekTimeRef.current = Date.now();
            hasSyncedRef.current = true; // Đánh dấu đã sync
          } else if (loadedId === targetId || (!loadedId && !currentStateId)) {
            // Same video, seek to correct time một lần
            if (localTime === null || diff > 0.5) {
              console.log('[SYNC-RESPONSE] Initial sync - Seeking to', serverTime, 'from', localTime !== null ? localTime : 'undefined');
              try {
                playerRef.current.seekTo(serverTime, true);
                hasSyncedRef.current = true; // Đánh dấu đã sync, không sync nữa
              } catch (e) {
                console.error('[SYNC-RESPONSE] Error seeking', e);
              }
            } else {
              // Đã sync gần đúng, không cần sync nữa
              hasSyncedRef.current = true;
            }
          }
          
          // Ensure playing state matches
          if (isPlaying) {
            if (playerState !== window.YT.PlayerState.PLAYING) {
              console.log('[SYNC-RESPONSE] Auto-playing video');
              playerRef.current.playVideo();
            }
          } else {
            if (playerState === window.YT.PlayerState.PLAYING) {
              playerRef.current.pauseVideo();
            }
          }
          // Volume will be synced by the volume sync effect
          setTimeout(() => {
            isSyncingRef.current = false;
          }, 300);
        }
      });

      // Nhận time-broadcast từ server (chỉ sync một lần khi join, sau đó bỏ qua)
      socket.on('time-broadcast', ({ baseTime, serverTs, isPlaying, videoId }) => {
        // Chỉ sync một lần khi join, sau đó không sync nữa để tránh giật
        if (hasSyncedRef.current) return;
        if (!playerRef.current) return;
        
        // Kiểm tra video đã load chưa
        try {
          const data = playerRef.current.getVideoData && playerRef.current.getVideoData();
          const loadedVideoId = data && data.video_id ? data.video_id : null;
          // Nếu khác video đang phát, bỏ qua (sự kiện video-play sẽ xử lý)
          if (videoId && loadedVideoId && loadedVideoId !== videoId) return;
          // Nếu video chưa load (không có video_id), bỏ qua để tránh seek khi chưa có video
          if (videoId && !loadedVideoId) return;
        } catch (e) {}

        // Check if video is ready (can get current time)
        let localTime = null;
        try {
          if (playerRef.current.getCurrentTime) {
            const time = playerRef.current.getCurrentTime();
            if (typeof time === 'number' && !isNaN(time) && time >= 0) {
              localTime = time;
            }
          }
        } catch (e) {
          // Ignore errors
        }
        
        const serverTime = (() => {
          const base = baseTime ?? 0;
          // baseTime từ server đã là live time tại serverTs, chỉ cần bù latency
          const latency = serverTs ? Math.max(0, (Date.now() - serverTs) / 1000) : 0;
          return isPlaying ? base + latency : base;
        })();
        
        // Chỉ sync một lần nếu chưa có localTime hoặc lệch lớn
        if (localTime === null || Math.abs(serverTime - localTime) > 0.5) {
          console.log('[TIME-BROADCAST] Initial sync', { localTime, serverTime, baseTime, serverTs });
          try {
            playerRef.current.seekTo(serverTime, true);
            hasSyncedRef.current = true; // Đánh dấu đã sync, không sync nữa
          } catch (e) {
            console.error('[TIME-BROADCAST] Error seeking', e);
          }
        } else {
          // Đã sync gần đúng, không cần sync nữa
          hasSyncedRef.current = true;
        }
      });
    }
  }, [socket]);

  // Keep player volume/mute in sync when state changes
  useEffect(() => {
    // Update lastVolumeCheckRef when state changes
    lastVolumeCheckRef.current.volume = volume;
    lastVolumeCheckRef.current.muted = muted || volume === 0;
    lastVolumeCheckRef.current.lastCheck = Date.now();
    // Apply volume settings
    applyVolumeSettings();
  }, [volume, muted]);

  // Không có volume check interval - chỉ điều chỉnh volume khi user thay đổi qua button

  // Không cần sync-request định kỳ nữa - chỉ sync một lần khi join

  // Check for video ended periodically (fallback if onStateChange doesn't fire)
  useEffect(() => {
    if (!playerRef.current || !socket || !joined) {
      console.log('[VIDEO-ENDED-CHECK] Interval not started: missing player/socket/joined');
      return;
    }
    if (!leaderId || !mySocketId || mySocketId !== leaderId) {
      console.log('[VIDEO-ENDED-CHECK] Interval not started: not leader', { mySocketId, leaderId });
      return;
    }
    if (!currentVideo) {
      console.log('[VIDEO-ENDED-CHECK] Interval not started: no current video');
      return;
    }
    
    console.log('[VIDEO-ENDED-CHECK] Starting interval check for video ended');
    
    const checkEndedInterval = setInterval(() => {
      try {
        if (playerRef.current && playerRef.current.getPlayerState) {
          const state = playerRef.current.getPlayerState();
          const currentTime = playerRef.current.getCurrentTime ? playerRef.current.getCurrentTime() : 0;
          const duration = playerRef.current.getDuration ? playerRef.current.getDuration() : 0;
          
          // Đảm bảo currentTime và duration là số hợp lệ
          const safeCurrentTime = typeof currentTime === 'number' && !isNaN(currentTime) ? currentTime : 0;
          const safeDuration = typeof duration === 'number' && !isNaN(duration) ? duration : 0;
          
          // Log thông tin video mỗi 5 giây để debug (hoặc khi gần kết thúc)
          const shouldLog = safeDuration > 0 && (safeCurrentTime >= safeDuration - 5 || Math.floor(safeCurrentTime) % 5 === 0);
          if (shouldLog) {
            console.log('[VIDEO-ENDED-CHECK] Status check', { 
              videoId: currentVideo?.videoId, 
              title: currentVideo?.title,
              currentTime: safeCurrentTime.toFixed(2), 
              duration: safeDuration.toFixed(2), 
              remaining: safeDuration > 0 ? (safeDuration - safeCurrentTime).toFixed(2) : 'N/A',
              state, 
              stateName: state === window.YT.PlayerState.ENDED ? 'ENDED' : 
                        state === window.YT.PlayerState.PLAYING ? 'PLAYING' :
                        state === window.YT.PlayerState.PAUSED ? 'PAUSED' :
                        state === window.YT.PlayerState.CUED ? 'CUED' :
                        state === window.YT.PlayerState.BUFFERING ? 'BUFFERING' : 'UNKNOWN',
              isPlaying, 
              isLeader: mySocketId === leaderId,
              queueLength: queue.length,
              alreadyEmitted: videoEndedEmittedRef.current
            });
          }
          
          // Check if video ended (state is ENDED or currentTime >= duration - 0.5s)
          const isEnded = state === window.YT.PlayerState.ENDED;
          const isNearEnd = safeDuration > 0 && safeCurrentTime >= safeDuration - 0.5 && isPlaying;
          
          if (!videoEndedEmittedRef.current && (isEnded || isNearEnd)) {
            console.log('[CLIENT] ========== VIDEO-ENDED-CHECK (INTERVAL) ==========');
            console.log('[VIDEO-ENDED-CHECK] 🎬 VIDEO ENDED DETECTED!', { 
              videoId: currentVideo?.videoId, 
              title: currentVideo?.title,
              state, 
              stateName: isEnded ? 'ENDED' : 'NEAR_END',
              currentTime: safeCurrentTime.toFixed(2), 
              duration: safeDuration.toFixed(2), 
              isPlaying, 
              isLeader: mySocketId === leaderId,
              queueLength: queue.length,
              queueVideos: queue.map(v => ({ id: v.videoId, title: v.title })),
              isEnded,
              isNearEnd
            });
            videoEndedEmittedRef.current = true;
            socket.emit('video-ended', { roomId });
            console.log('[VIDEO-ENDED-CHECK] ✅ video-ended event emitted from interval check');
            console.log('[CLIENT] ===================================================');
          }
        }
      } catch (e) {
        console.error('[VIDEO-ENDED-CHECK] Error checking video ended', e);
      }
    }, 1000); // Check every second
    
    return () => {
      console.log('[VIDEO-ENDED-CHECK] Stopping interval check');
      clearInterval(checkEndedInterval);
    };
  }, [player, socket, joined, roomId, currentVideo, leaderId, mySocketId, isPlaying, queue]);

  const handleJoinRoom = (e) => {
    e.preventDefault();
    if (roomId.trim()) {
      setJoined(true);
    }
  };

  const handleLeaveRoom = () => {
    if (socket) {
      socket.close();
    }
    setJoined(false);
    setCurrentVideo(null);
    setQueue([]);
    setIsPlaying(false);
    setUsers([]);
    setRoomId('');
    setUsername('');
    setMessages([]);
    setChatInput('');
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    try {
      // Tính toán lại API URL động
      const currentHostname = window.location.hostname;
      const currentProtocol = window.location.protocol;
      let dynamicAPIURL = API_URL;
      
      if (currentHostname !== 'localhost' && currentHostname !== '127.0.0.1') {
        if (currentHostname === 'music.khanhcs.id.vn') {
          dynamicAPIURL = `${currentProtocol}//apimusic.khanhcs.id.vn/api`;
        } else if (process.env.REACT_APP_API_URL) {
          dynamicAPIURL = `${process.env.REACT_APP_API_URL}/api`;
        }
      }
      
      console.log('Search API URL:', dynamicAPIURL);
      
      setSearchResults([]); // Clear previous results
      const response = await axios.get(`${dynamicAPIURL}/search`, {
        params: { q: searchQuery }
      });
      
      if (response.data && response.data.length > 0) {
        setSearchResults(response.data);
      } else {
        alert('Không tìm thấy kết quả. Vui lòng thử từ khóa khác.');
      }
    } catch (error) {
      console.error('Search error:', error);
      if (error.response && error.response.status === 404) {
        alert('Không tìm thấy kết quả. Vui lòng thử từ khóa khác.');
      } else {
        alert('Lỗi khi tìm kiếm. Vui lòng thử lại sau.');
      }
    }
  };

  const formatChatTime = (timestamp) => {
    if (!timestamp) return '';
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (error) {
      return '';
    }
  };

  const sendChatMessage = () => {
    if (!socket || !roomId) return;
    const trimmed = chatInput.trim();
    if (!trimmed) return;
    socket.emit('chat-message', {
      roomId,
      text: trimmed,
      username: username || 'Anonymous',
    });
    setChatInput('');
    // Reset height after send
    if (chatInputRef.current) {
      chatInputRef.current.style.height = '40px';
    }
  };
  const autoResizeChat = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 160; // cap growth
    el.style.height = Math.min(el.scrollHeight, maxHeight) + 'px';
  };

  const handleChatChange = (e) => {
    setChatInput(e.target.value);
    autoResizeChat(e.target);
  };

  const handleChatSubmit = (e) => {
    e.preventDefault();
    sendChatMessage();
  };

  const handleChatKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  };

  const handleAddToQueue = (e, video) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    if (socket) {
      socket.emit('add-to-queue', { roomId, video });
      // Giữ nguyên kết quả tìm kiếm và input theo yêu cầu
    }
  };

  // Phát theo thứ tự: chỉ thêm vào queue, quản lý bằng next-video trên server

  const handleRemoveFromQueue = (index) => {
    if (socket) {
      socket.emit('remove-from-queue', { roomId, index });
    }
  };

  const handleNextVideo = () => {
    if (socket) {
      socket.emit('next-video', { roomId });
    }
  };

  const handlePlayFromQueue = (index) => {
    if (socket) {
      socket.emit('play-from-queue', { roomId, index });
    }
  };

  if (!joined) {
    return (
      <div className="app">
        <div className="join-room-container">
          <div className="join-room-card">
            <h1>♪ WebMusic</h1>
            <p className="subtitle">Nghe nhạc cùng nhau trong room</p>
            <form onSubmit={handleJoinRoom} className="join-form">
              <input
                type="text"
                placeholder="Tên của bạn (tùy chọn)"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="input-field"
              />
              <input
                type="text"
                placeholder="Nhập Room ID"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="input-field"
                required
              />
              <button type="submit" className="btn-primary">
                Tham gia Room
              </button>
            </form>
            <p className="room-hint">
              💡 Tạo room mới bằng cách nhập một ID bất kỳ
            </p>
            
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-content">
          <h1>♪ WebMusic</h1>
          <div className="room-info">
            <span className="room-id">Room: {roomId}</span>
            <span className="username">{username || 'Anonymous'}</span>
            <button onClick={handleLeaveRoom} className="btn-secondary">
              Rời Room
            </button>
          </div>
        </div>
      </header>

      <div className="main-container">
        <div className="player-section">
          <div className="player-wrapper">
            <div id="youtube-player"></div>
          </div>
          
          <div className="video-info">
            {currentVideo ? (
              <h3>{currentVideo.title}</h3>
            ) : (
              <h3 style={{ color: '#999', fontStyle: 'italic' }}>Chưa có video đang phát</h3>
            )}
          </div>

          <div className="controls">
            {queue.length > 0 && (
              <button onClick={handleNextVideo} className="btn-primary">
                ⏭ Bài tiếp theo
              </button>
            )}
            <div className="volume-controls">
              <button onClick={toggleMute} className="btn-volume" title={muted ? 'Unmute' : 'Mute'}>
                {muted ? '🔇' : '🔊'}
              </button>
              <input
                type="range"
                min="0"
                max="100"
                value={volume}
                onChange={handleVolumeInput}
                className="volume-slider"
                aria-label="volume"
              />
              <span className="volume-value">{volume}%</span>
            </div>
          </div>

          <div className="chat-section">
            <h2>Chat</h2>
            <div className="chat-messages">
              {messages.length === 0 ? (
                <p className="chat-empty">Chưa có tin nhắn nào. Hãy là người mở đầu nhé!</p>
              ) : (
                messages.map((message) => {
                  const isOwn = message.userId === mySocketId;
                  return (
                    <div
                      key={message.id}
                      className={`chat-message${isOwn ? ' chat-message-own' : ''}`}
                    >
                      <div className="chat-message-meta">
                        <span className="chat-message-user">{isOwn ? 'Bạn' : message.username || 'Anonymous'}</span>
                        <span className="chat-message-time">{formatChatTime(message.createdAt)}</span>
                      </div>
                      <div className="chat-message-text">{message.text}</div>
                    </div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>
            <form className="chat-form" onSubmit={handleChatSubmit}>
              <textarea
                ref={chatInputRef}
                value={chatInput}
                onChange={handleChatChange}
                onKeyDown={handleChatKeyDown}
                placeholder="Nhập tin nhắn..."
                className="chat-input"
                maxLength={1000}
                disabled={!socket}
                rows={1}
                style={{height: '40px'}}
              />
              <button type="submit" className="btn-primary" disabled={!socket || !chatInput.trim()}>
                Gửi
              </button>
            </form>
          </div>
        </div>

        <div className="queue-section">
          <h2>Danh sách phát ({queue.length})</h2>
          {queue.length === 0 ? (
            <p className="empty-queue">Danh sách trống</p>
          ) : (
            <div className="queue-list">
              {queue.map((video, index) => (
                <div key={index} className="queue-item" onDoubleClick={() => handlePlayFromQueue(index)}>
                  <img src={video.thumbnail} alt={video.title} />
                  <div className="queue-info">
                    <p>{video.title}</p>
                  </div>
                  <div className="queue-item-actions">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveFromQueue(index);
                      }}
                      className="btn-remove"
                      title="Xóa khỏi danh sách"
                    >
                      ✖
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sidebar">
          <div className="users-section">
            <h2>Người trong room ({users.length})</h2>
            {users.length === 0 ? (
              <p className="empty-users">Chưa có người nào</p>
            ) : (
              <div className="users-list">
                {users.map((user, index) => (
                  <div key={user.id || index} className="user-item">
                    <span className="user-avatar">●</span>
                    <span className="user-name">{user.username}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="search-section">
            <h2>Tìm kiếm</h2>
            <form onSubmit={handleSearch} className="search-form">
              <input
                type="text"
                placeholder="Tìm kiếm bài hát, URL YouTube hoặc Video ID"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="input-field"
                ref={searchInputRef}
              />
              <button type="submit" className="btn-primary">
                Tìm
              </button>
            </form>

            {searchResults.length > 0 && (
              <div className="search-results">
                {searchResults.map((video, index) => (
                  <div key={index} className="search-result-item">
                    <img src={video.thumbnail} alt={video.title} />
                    <div className="result-info">
                      <p>{video.title}</p>
                      <div className="result-actions">
                        {/* Phát theo order của queue, bỏ nút phát ngay */}
                        <button
                          type="button"
                          onClick={(e) => handleAddToQueue(e, video)}
                          className="btn-small"
                        >
                          + Danh sách phát
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;