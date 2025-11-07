# WebMusic - Room-based Music Player

Ứng dụng web nghe nhạc với tính năng chia room, đồng bộ real-time và tích hợp YouTube API.

## Tính năng

- 🎵 Phát nhạc từ YouTube
- 🏠 Tạo và tham gia room dựa trên ID
- 🔄 Đồng bộ hóa real-time giữa các users trong cùng room
- 📋 Quản lý danh sách phát (playlist/queue)
- ⏯️ Điều khiển phát nhạc đồng bộ (play, pause, seek)
- 🔍 Tìm kiếm video YouTube

## Yêu cầu hệ thống

- Node.js >= 14.x
- npm >= 6.x

## Cài đặt

```bash
# Cài đặt dependencies cho cả backend và frontend
npm run install-all

# Hoặc cài đặt riêng lẻ:
npm install                    # Backend dependencies
cd client && npm install       # Frontend dependencies
```

## Chạy ứng dụng

### Cách 1: Chạy cả backend và frontend cùng lúc
```bash
npm run dev
```

### Cách 2: Chạy riêng lẻ
```bash
# Terminal 1: Chạy backend
npm run server

# Terminal 2: Chạy frontend
npm run client
```

Backend sẽ chạy trên `http://localhost:5000`  
Frontend sẽ chạy trên `http://localhost:3000`

## Sử dụng

1. Mở trình duyệt và truy cập `http://localhost:3000`
2. Nhập tên của bạn (tùy chọn) và Room ID để tạo hoặc tham gia room
   - Room ID có thể là bất kỳ chuỗi nào (ví dụ: "room1", "abc123")
   - Nếu room chưa tồn tại, nó sẽ được tạo tự động
3. Tìm kiếm bài hát:
   - Nhập tên bài hát, URL YouTube hoặc Video ID
   - Click "Tìm" để tìm kiếm
4. Thêm bài hát vào queue:
   - Click "Phát ngay" để phát ngay lập tức
   - Click "Thêm vào queue" để thêm vào danh sách phát
5. Điều khiển:
   - Play/Pause: Sử dụng controls của YouTube player
   - Bài tiếp theo: Click "⏭️ Bài tiếp theo" để chuyển bài trong queue
   - Xóa khỏi queue: Click "❌" trên item trong queue

## Cách hoạt động

- **Room-based**: Mỗi room có ID riêng, users trong cùng room sẽ đồng bộ với nhau
- **Real-time sync**: Sử dụng Socket.io để đồng bộ play/pause/seek giữa các users
- **Queue management**: Danh sách phát được quản lý trên server và đồng bộ real-time
- **YouTube Integration**: Sử dụng YouTube IFrame API để phát video

## Cấu trúc dự án

```
webmusic/
├── server.js          # Backend server với Express + Socket.io
├── package.json       # Backend dependencies
├── client/            # Frontend React app
│   ├── src/
│   │   ├── App.js     # Main React component
│   │   └── App.css    # Styles
│   └── package.json   # Frontend dependencies
└── README.md
```

## API Endpoints

### GET `/api/search?q=query`
Tìm kiếm video trên YouTube

### GET `/api/rooms/:roomId`
Lấy thông tin room

### POST `/api/rooms/:roomId/queue`
Thêm video vào queue

### DELETE `/api/rooms/:roomId/queue/:index`
Xóa video khỏi queue

## Socket Events

### Client → Server
- `join-room`: Tham gia room
- `play-video`: Phát video
- `pause-video`: Tạm dừng
- `resume-video`: Tiếp tục phát
- `seek-video`: Nhảy đến thời điểm
- `next-video`: Chuyển bài tiếp theo
- `add-to-queue`: Thêm vào queue
- `remove-from-queue`: Xóa khỏi queue
- `sync-request`: Yêu cầu đồng bộ

### Server → Client
- `room-state`: Trạng thái room hiện tại
- `video-play`: Phát video
- `video-pause`: Tạm dừng
- `video-resume`: Tiếp tục
- `video-seek`: Nhảy đến thời điểm
- `queue-updated`: Queue đã cập nhật
- `sync-response`: Phản hồi đồng bộ

## Lưu ý

- Room sẽ tự động bị xóa khi không còn user nào
- Cần kết nối internet để sử dụng YouTube API
- Đảm bảo cổng 5000 và 3000 không bị chiếm dụng
