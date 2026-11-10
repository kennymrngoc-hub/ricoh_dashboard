const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Mở cửa cho phép điện thoại tải file index.html từ máy tính
app.use(express.static(__dirname));

const dbFile = path.join(__dirname, 'database.json');

// Hàm đọc/ghi Cơ sở dữ liệu trung tâm
const readDB = () => {
    if (!fs.existsSync(dbFile)) return {};
    try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch(e) { return {}; }
};
const writeDB = (data) => fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));

// API 1: Phục vụ kéo toàn bộ dữ liệu mới nhất từ Server về các thiết bị
app.get('/api/sync-all', (req, res) => {
    res.json(readDB());
});

// API 2: Nhận dữ liệu cập nhật từ các máy điện thoại nhân viên đẩy lên
app.post('/api/sync-key', (req, res) => {
    const { key, data } = req.body;
    let db = readDB();
    db[key] = data; // Ghi đè cập nhật mới nhất vào bộ nhớ chung
    writeDB(db);
    res.json({ success: true });
});

// Mở cổng mạng
const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n==========================================`);
    console.log(`🚀 MÁY CHỦ ERP XUÂN NHI ĐANG CHẠY TỐT 🚀`);
    console.log(`==========================================`);
    console.log(`👉 Xem trên máy Admin: http://localhost:${PORT}`);
    console.log(`👉 Xem trên Điện thoại: Nhập địa chỉ IPv4 của máy Admin này (Ví dụ: http://192.168.1.XXX:${PORT})`);
    console.log(`Lưu ý: Luôn treo cửa sổ đen này trong suốt ca làm việc để hệ thống đồng bộ!\n`);
});