const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const YouTube = require('youtube-sr').default;
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true, // Cho phép Engine.IO v3 clients
});

app.use(cors());
app.use(express.json());

// Lưu trữ state của các rooms
const rooms = new Map();
// Bộ phát nhịp đồng bộ thời gian theo room
const tickers = new Map();

// Model cho Room state
class RoomState {
  constructor(roomId) {
    this.roomId = roomId;
    this.currentVideo = null;
    this.currentTime = 0;
    this.isPlaying = false;
    this.queue = [];
    this.users = [];
    this.lastUpdatedAt = Date.now(); // ms
    this.leaderId = null; // socket id phát time-update
    this.messages = [];
  }

  addToQueue(video) {
    this.queue.push(video);
    console.log('[ROOM-STATE] Video added to queue:', video.videoId, video.title, 'Queue length:', this.queue.length);
  }

  removeFromQueue(index) {
    if (index >= 0 && index < this.queue.length) {
      return this.queue.splice(index, 1)[0];
    }
    return null;
  }

  nextVideo() {
    console.log('[ROOM-STATE] nextVideo() called, queue length:', this.queue.length);
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      console.log('[ROOM-STATE] nextVideo() returning:', next.videoId, next.title, 'Remaining queue length:', this.queue.length);
      this.currentVideo = next;
      this.currentTime = 0;
      this.lastUpdatedAt = Date.now();
      return next;
    }
    console.log('[ROOM-STATE] nextVideo() returning null - queue is empty');
    return null;
  }
}

function getLiveCurrentTime(room) {
  if (!room) return 0;
  if (!room.isPlaying) return room.currentTime || 0;
  const elapsed = (Date.now() - (room.lastUpdatedAt || Date.now())) / 1000;
  return (room.currentTime || 0) + Math.max(0, elapsed);
}

function startTicker(roomId) {
  if (tickers.has(roomId)) {
    console.log(`[SERVER] [TICKER] Ticker already running for room:`, roomId);
    return;
  }
  console.log(`[SERVER] [TICKER] 🟢 Starting ticker for room:`, roomId);
  const interval = setInterval(() => {
    const room = rooms.get(roomId);
    if (!room) {
      console.log(`[SERVER] [TICKER] ⚠️  Room not found, stopping ticker:`, roomId);
      stopTicker(roomId);
      return;
    }
    // phát nhịp thời gian để client bù trễ, kể cả khi leader bị throttle
    const liveTime = getLiveCurrentTime(room);
    const nowTs = Date.now();
    io.to(roomId).emit('time-broadcast', {
      baseTime: liveTime, // Gửi live time tại serverTs, client sẽ bù latency
      serverTs: nowTs,
      isPlaying: room.isPlaying,
      videoId: room.currentVideo?.videoId || null,
    });
  }, 1000);
  tickers.set(roomId, interval);
  console.log(`[SERVER] [TICKER] ✅ Ticker started for room:`, roomId);
}

function stopTicker(roomId) {
  const t = tickers.get(roomId);
  if (t) {
    clearInterval(t);
    tickers.delete(roomId);
    console.log(`[SERVER] [TICKER] 🔴 Stopped ticker for room:`, roomId);
  } else {
    console.log(`[SERVER] [TICKER] ⚠️  No ticker found for room:`, roomId);
  }
}

function createChatMessage({ room, socket, username, text }) {
  if (!room || !text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    userId: socket.id,
    username: username || 'Anonymous',
    text: trimmed.slice(0, 1000),
    createdAt: Date.now()
  };
  room.messages.push(message);
  if (room.messages.length > 100) {
    room.messages = room.messages.slice(-100);
  }
  return message;
}

// Helper function to extract video ID from URL
function extractVideoId(url) {
  const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
  const match = url.match(regExp);
  return (match && match[2].length === 11) ? match[2] : url;
}

// API Routes
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  
  if (!q) {
    return res.status(400).json({ error: 'Query parameter is required' });
  }

  try {
    // Helper: fallback via public Piped API when direct fetch is blocked/timeouts
    const fallbackSearch = async (query) => {
      try {
        const { data } = await axios.get('https://piped.video/api/v1/search', {
          params: { q: query, region: 'VN' },
          timeout: 8000,
        });
        if (!Array.isArray(data)) return [];
        return data
          .filter((v) => v.type === 'video' && v.id)
          .slice(0, 10)
          .map((v) => ({
            videoId: v.id,
            title: v.title,
            thumbnail: (v.thumbnails && v.thumbnails[0]?.url) || `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`,
            duration: v.duration,
            channel: v.uploader || 'Unknown'
          }));
      } catch (e) {
        return [];
      }
    };

    // Check if it's a URL or video ID
    const videoId = extractVideoId(q);
    
    // If it looks like a video ID (11 characters), try to get video info
    if (videoId.length === 11 && !q.includes('youtube.com') && !q.includes('youtu.be')) {
      try {
        const video = await YouTube.getVideo(`https://www.youtube.com/watch?v=${videoId}`);
        if (video) {
          return res.json([{
            videoId: video.id,
            title: video.title,
            thumbnail: video.thumbnail?.displayURL || `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`,
            duration: video.durationFormatted
          }]);
        }
      } catch (err) {
        // Fallback: assume it's a valid video ID
        return res.json([{
          videoId: videoId,
          title: q,
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        }]);
      }
    }

    // Search YouTube with retry; if network blocked, fallback to Piped API
    let results = [];
    let ytError = null;
    for (let i = 0; i < 2; i++) {
      try {
        results = await YouTube.search(q, { limit: 10, type: 'video', requestOptions: { fetchOptions: { timeout: 8000 } } });
        break;
      } catch (err) {
        ytError = err;
        // Ignore known transient youtube-sr parse errors and continue to retry/fallback
        if (String(err?.message || '').includes('browseId')) {
          results = [];
          continue;
        }
      }
    }
    if (!results || results.length === 0) {
      const fallback = await fallbackSearch(q);
      if (fallback.length > 0) {
        return res.json(fallback);
      }
      if (ytError) throw ytError;
    }
    
    const videos = results
      .filter(video => video && video.id) // Filter out invalid results
      .map(video => {
        try {
          return {
            videoId: video.id,
            title: video.title || 'Unknown Title',
            thumbnail: video.thumbnail?.displayURL || video.thumbnail?.url || `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`,
            duration: video.durationFormatted || 'N/A',
            channel: video.channel?.name || 'Unknown'
          };
        } catch (err) {
          console.error('Error parsing video:', err);
          return null;
        }
      })
      .filter(video => video !== null); // Remove null entries

    if (videos.length === 0) {
      return res.status(404).json({ error: 'No videos found', message: 'Try a different search term' });
    }

    res.json(videos);
  } catch (error) {
    // Final safety: try public fallback; if it also fails, return empty list to avoid UI error states
    try {
      const fallback = await (async () => {
        try {
          const { data } = await axios.get('https://piped.video/api/v1/search', {
            params: { q, region: 'VN' },
            timeout: 8000,
          });
          if (!Array.isArray(data)) return [];
          return data
            .filter((v) => v.type === 'video' && v.id)
            .slice(0, 10)
            .map((v) => ({
              videoId: v.id,
              title: v.title,
              thumbnail: (v.thumbnails && v.thumbnails[0]?.url) || `https://img.youtube.com/vi/${v.id}/hqdefault.jpg`,
              duration: v.duration,
              channel: v.uploader || 'Unknown'
            }));
        } catch {
          return [];
        }
      })();
      console.warn('YouTube search failed, served via fallback:', error?.message);
      return res.json(fallback);
    } catch {
      console.warn('Search failed and fallback unavailable:', error?.message);
      return res.status(200).json([]);
    }
  }
});

app.get('/api/rooms/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  res.json({
    roomId: room.roomId,
    currentVideo: room.currentVideo,
    queue: room.queue,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime,
    userCount: room.users.length
  });
});

app.post('/api/rooms/:roomId/queue', (req, res) => {
  const { roomId } = req.params;
  const { video } = req.body;
  
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new RoomState(roomId));
  }
  
  const room = rooms.get(roomId);
  room.addToQueue(video);
  
  io.to(roomId).emit('queue-updated', { queue: room.queue });
  
  res.json({ success: true, queue: room.queue });
});

app.delete('/api/rooms/:roomId/queue/:index', (req, res) => {
  const { roomId, index } = req.params;
  const room = rooms.get(roomId);
  
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  
  const removed = room.removeFromQueue(parseInt(index));
  
  if (removed) {
    io.to(roomId).emit('queue-updated', { queue: room.queue });
    res.json({ success: true, queue: room.queue });
  } else {
    res.status(400).json({ error: 'Invalid index' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, username }) => {
    socket.join(roomId);
    
    // Tạo room nếu chưa tồn tại
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new RoomState(roomId));
    }
    
    const room = rooms.get(roomId);
    room.users.push({ id: socket.id, username: username || 'Anonymous' });
    if (!room.leaderId) {
      room.leaderId = socket.id;
    }
    
    // Gửi state hiện tại của room cho user mới (tính thời gian đang phát chính xác)
    const nowTs = Date.now();
    // Gửi baseTime = room.currentTime (thời điểm cập nhật cuối), client sẽ tự tính live time
    socket.emit('room-state', {
      currentVideo: room.currentVideo,
      // baseTime là currentTime tại thời điểm lastUpdatedAt, client sẽ tự tính live time dựa trên serverTs
      baseTime: room.currentTime || 0,
      serverTs: nowTs,
      lastUpdatedAt: room.lastUpdatedAt || nowTs, // Thêm lastUpdatedAt để client tính chính xác hơn
      isPlaying: room.isPlaying,
      queue: room.queue,
      users: room.users,
      leaderId: room.leaderId
    });
    // Nếu đang có bài phát, ép client mới load & seek đúng thời điểm
    if (room.currentVideo) {
      // Lấy currentTime chính xác từ leader (liveTime tại thời điểm hiện tại)
      const liveTime = getLiveCurrentTime(room);
      console.log('[SERVER] User join - sending video-play', {
        roomId,
        videoId: room.currentVideo.videoId,
        liveTime,
        currentTime: room.currentTime,
        lastUpdatedAt: room.lastUpdatedAt,
        isPlaying: room.isPlaying,
        leaderId: room.leaderId
      });
      
      socket.emit('video-play', {
        videoId: room.currentVideo.videoId,
        title: room.currentVideo.title,
        thumbnail: room.currentVideo.thumbnail,
        currentTime: liveTime, // Gửi live time (currentTime của leader) để client load đúng vị trí
        serverTs: nowTs,
        isPlaying: room.isPlaying // Gửi isPlaying để client biết có cần tự động play không
      });
      // Phát ngay một nhịp thời gian riêng cho socket mới để bám kịp mốc hiện tại
      socket.emit('time-broadcast', {
        baseTime: liveTime, // Gửi live time (currentTime của leader), client sẽ bù latency
        serverTs: nowTs,
        isPlaying: room.isPlaying,
        videoId: room.currentVideo?.videoId || null,
      });
    }
    
    // Thông báo cho tất cả users trong room (bao gồm cả user mới)
    io.to(roomId).emit('users-updated', {
      users: room.users
    });
    
    // Gửi lịch sử chat gần nhất cho user mới
    if (room.messages && room.messages.length > 0) {
      socket.emit('chat-history', {
        messages: room.messages.slice(-50)
      });
    }

    console.log(`User ${socket.id} joined room ${roomId}`);
  });

  socket.on('play-video', ({ roomId, videoId, title, thumbnail }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.currentVideo = { videoId, title, thumbnail };
    room.currentTime = 0;
    room.lastUpdatedAt = Date.now();
    room.isPlaying = true;
    room.leaderId = socket.id;
    
    // Broadcast đến tất cả users trong room (bao gồm cả người gửi)
    io.to(roomId).emit('video-play', {
      videoId,
      title,
      thumbnail,
      currentTime: 0,
      serverTs: Date.now(),
      isPlaying: true
    });
    startTicker(roomId);
  });

  socket.on('pause-video', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    // Cập nhật lại currentTime tại thời điểm pause
    room.currentTime = getLiveCurrentTime(room);
    room.isPlaying = false;
    socket.to(roomId).emit('video-pause');
    stopTicker(roomId);
  });

  socket.on('resume-video', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.lastUpdatedAt = Date.now();
    room.isPlaying = true;
    socket.to(roomId).emit('video-resume');
    startTicker(roomId);
  });

  socket.on('seek-video', ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.currentTime = time;
    room.lastUpdatedAt = Date.now();
    // Người tua trở thành leader tạm thời để đồng bộ thời gian
    room.leaderId = socket.id;
    io.to(roomId).emit('video-seek', { time });
  });

  socket.on('time-update', ({ roomId, time }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (socket.id !== room.leaderId) return; // ignore non-leader updates
    
    // Validate time
    if (typeof time !== 'number' || isNaN(time) || time < 0) {
      console.log('[SERVER] time-update: Invalid time value', { time });
      return;
    }
    
    // Chỉ update nếu time hợp lệ và không nhảy quá lớn (tránh drift)
    const currentLiveTime = getLiveCurrentTime(room);
    const timeDiff = Math.abs(time - currentLiveTime);
    // Cho phép update lớn nếu:
    // 1. Video vừa mới load (currentTime < 1s và < 3s từ lúc load)
    // 2. Video vừa resume (lastUpdatedAt vừa được update < 1s)
    const isNewVideo = room.currentTime < 1 && (Date.now() - room.lastUpdatedAt) < 3000;
    const justResumed = room.isPlaying && (Date.now() - room.lastUpdatedAt) < 1000;
    
    if (!isNewVideo && !justResumed && timeDiff > 2 && currentLiveTime > 1) {
      console.log('[SERVER] time-update: Ignoring large time jump', { time, currentLiveTime, diff: timeDiff, storedTime: room.currentTime, isPlaying: room.isPlaying });
      return;
    }
    
    room.currentTime = time;
    room.lastUpdatedAt = Date.now();
    // Không emit time-broadcast ở đây để tránh conflict với ticker
    // Ticker sẽ tự động phát mỗi giây với liveTime đúng
  });

  socket.on('next-video', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    const nextVideo = room.nextVideo();
    if (nextVideo) {
      room.currentVideo = nextVideo;
      room.currentTime = 0;
      room.isPlaying = true;
      
    io.to(roomId).emit('video-play', {
        videoId: nextVideo.videoId,
        title: nextVideo.title,
        thumbnail: nextVideo.thumbnail,
        currentTime: 0,
        serverTs: Date.now(),
        isPlaying: true
      });

      // Broadcast queue update so clients can refresh UI
      io.to(roomId).emit('queue-updated', { queue: room.queue });
      startTicker(roomId);
    }
  });

  // Khi video kết thúc tự nhiên, leader thông báo để chuyển bài
  socket.on('video-ended', ({ roomId }) => {
    const timestamp = new Date().toISOString();
    console.log('\n[SERVER] ========== VIDEO-ENDED EVENT ==========');
    console.log(`[SERVER] [${timestamp}] video-ended received from socket:`, socket.id, 'room:', roomId);
    const room = rooms.get(roomId);
    if (!room) {
      console.log(`[SERVER] [${timestamp}] ❌ video-ended: Room not found:`, roomId);
      console.log('[SERVER] ===========================================\n');
      return;
    }
    if (socket.id !== room.leaderId) {
      console.log(`[SERVER] [${timestamp}] ❌ video-ended: Not leader!`, {
        sender: socket.id,
        currentLeader: room.leaderId,
        roomId
      });
      console.log('[SERVER] ===========================================\n');
      return;
    }
    console.log(`[SERVER] [${timestamp}] ✅ video-ended: Valid leader, processing...`);
    console.log(`[SERVER] [${timestamp}] Current video:`, {
      videoId: room.currentVideo?.videoId,
      title: room.currentVideo?.title,
      currentTime: room.currentTime,
      isPlaying: room.isPlaying
    });
    console.log(`[SERVER] [${timestamp}] Queue status:`, {
      length: room.queue.length,
      contents: room.queue.map(v => ({ id: v.videoId, title: v.title }))
    });
    
    const nextVideo = room.nextVideo();
    if (nextVideo) {
      console.log(`[SERVER] [${timestamp}] ✅ Next video found:`, {
        videoId: nextVideo.videoId,
        title: nextVideo.title,
        remainingQueueLength: room.queue.length
      });
      room.currentVideo = nextVideo;
      room.currentTime = 0;
      room.isPlaying = true;
      room.lastUpdatedAt = Date.now();
      
      const videoPlayData = {
        videoId: nextVideo.videoId,
        title: nextVideo.title,
        thumbnail: nextVideo.thumbnail,
        currentTime: 0,
        serverTs: Date.now(),
        isPlaying: true
      };
      
      console.log(`[SERVER] [${timestamp}] 📤 Emitting video-play to room:`, roomId, {
        videoId: videoPlayData.videoId,
        title: videoPlayData.title,
        isPlaying: videoPlayData.isPlaying,
        currentTime: videoPlayData.currentTime
      });
      
      io.to(roomId).emit('video-play', videoPlayData);
      io.to(roomId).emit('queue-updated', { queue: room.queue });
      
      console.log(`[SERVER] [${timestamp}] 🎬 Starting ticker for room:`, roomId);
      startTicker(roomId);
      
      console.log(`[SERVER] [${timestamp}] ✅ Video-ended handled successfully`);
      console.log('[SERVER] ===========================================\n');
    } else {
      console.log(`[SERVER] [${timestamp}] ❌ No more videos in queue, stopping playback`);
      room.isPlaying = false;
      stopTicker(roomId);
      console.log(`[SERVER] [${timestamp}] ⏹️  Playback stopped`);
      console.log('[SERVER] ===========================================\n');
    }
  });

  socket.on('add-to-queue', ({ roomId, video }) => {
    console.log('[SERVER] add-to-queue received from', socket.id, 'room:', roomId, 'video:', video?.videoId, video?.title);
    const room = rooms.get(roomId);
    if (!room) {
      console.log('[SERVER] add-to-queue: Room not found');
      return;
    }
    
    // Kiểm tra xem video đã có trong queue hoặc đang phát chưa
    const isInQueue = room.queue.some(v => v.videoId === video.videoId);
    const isCurrentVideo = room.currentVideo && room.currentVideo.videoId === video.videoId;
    
    if (isInQueue) {
      console.log('[SERVER] add-to-queue: Video already in queue, skipping:', video.videoId);
      return;
    }
    
    if (isCurrentVideo) {
      console.log('[SERVER] add-to-queue: Video is currently playing, skipping:', video.videoId);
      return;
    }
    
    room.addToQueue(video);
    console.log('[SERVER] add-to-queue: Video added, queue length:', room.queue.length, 'Current video:', room.currentVideo?.videoId);
    
    // Nếu chưa có video nào đang phát, tự động phát video đầu tiên trong queue
    if (!room.currentVideo && room.queue.length > 0) {
      console.log('[SERVER] add-to-queue: No current video, auto-playing first video in queue');
      const nextVideo = room.nextVideo();
      if (nextVideo) {
        room.currentVideo = nextVideo;
        room.currentTime = 0;
        room.isPlaying = true;
        room.lastUpdatedAt = Date.now();
        console.log('[SERVER] add-to-queue: Auto-playing video:', nextVideo.videoId, nextVideo.title);
        io.to(roomId).emit('video-play', {
          videoId: nextVideo.videoId,
          title: nextVideo.title,
          thumbnail: nextVideo.thumbnail,
          currentTime: 0,
          serverTs: Date.now(),
          isPlaying: true
        });
        startTicker(roomId);
      }
    }
    
    io.to(roomId).emit('queue-updated', { queue: room.queue });
  });

  socket.on('remove-from-queue', ({ roomId, index }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    room.removeFromQueue(index);
    io.to(roomId).emit('queue-updated', { queue: room.queue });
  });

  // Phát một bài bất kỳ trong queue theo index
  socket.on('play-from-queue', ({ roomId, index }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (index < 0 || index >= room.queue.length) return;
    const selected = room.queue.splice(index, 1)[0];
    if (!selected) return;
    room.currentVideo = selected;
    room.currentTime = 0;
    room.lastUpdatedAt = Date.now();
    room.isPlaying = true;
    room.leaderId = socket.id;

    io.to(roomId).emit('video-play', {
      videoId: selected.videoId,
      title: selected.title,
      thumbnail: selected.thumbnail,
      currentTime: 0,
      serverTs: Date.now(),
      isPlaying: true
    });
    io.to(roomId).emit('queue-updated', { queue: room.queue });
    startTicker(roomId);
  });

  socket.on('sync-request', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    
    const liveTime = getLiveCurrentTime(room);
    const nowTs = Date.now();
    socket.emit('sync-response', {
      currentVideo: room.currentVideo,
      baseTime: liveTime, // Gửi live time, client sẽ bù latency
      serverTs: nowTs,
      isPlaying: room.isPlaying
    });
  });

  socket.on('chat-message', ({ roomId, text, username }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const user = room.users.find((u) => u.id === socket.id);
    const displayName = username || user?.username || 'Anonymous';
    const message = createChatMessage({ room, socket, username: displayName, text });
    if (!message) return;

    io.to(roomId).emit('chat-message', message);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Xóa user khỏi tất cả rooms
    rooms.forEach((room, roomId) => {
      const userIndex = room.users.findIndex(user => user.id === socket.id);
      if (userIndex !== -1) {
        room.users = room.users.filter(user => user.id !== socket.id);
        
        if (room.users.length === 0) {
          // Xóa room nếu không còn user nào
          rooms.delete(roomId);
        stopTicker(roomId);
          console.log(`Room ${roomId} deleted (no users)`);
        } else {
          // Nếu leader rời đi, chọn leader mới
          if (room.leaderId === socket.id) {
            room.leaderId = room.users[0]?.id || null;
            io.to(roomId).emit('leader-changed', { leaderId: room.leaderId });
          }
          // Gửi danh sách users đã cập nhật cho các users còn lại
          io.to(roomId).emit('users-updated', {
            users: room.users
          });
        }
      }
    });
  });
});

// Serve production build for frontend (avoid dev-server WebSocket)
const clientBuildPath = path.join(__dirname, 'client', 'build');
app.use(express.static(clientBuildPath));

// SPA fallback: let React handle client routes
app.get('*', (req, res) => {
  // Do not interfere with Socket.io engine endpoint
  if (req.path.startsWith('/socket.io/')) return res.end();
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
