const puppeteer = require('puppeteer');
const fs = require('fs');
const fsP = require('fs').promises; 
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer'); // Thư viện xử lý upload file

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==========================================
// CẤU HÌNH ĐƯỜNG DẪN & CƠ SỞ DỮ LIỆU JSON
// ==========================================
const DATA_DIR = __dirname;
const HISTORY_DIR = path.join(DATA_DIR, 'history');
const AVATARS_DIR = path.join(DATA_DIR, 'avatars'); // Thư mục chứa ảnh
const AUDIO_DIR = path.join(DATA_DIR, 'audio');     // Thư mục chứa âm thanh
const FILES = {
    data: path.join(DATA_DIR, 'data.json'),
    dashboard: path.join(DATA_DIR, 'dashboard.json'),
    ink_history: path.join(DATA_DIR, 'ink_history.json'),
    parts_history: path.join(DATA_DIR, 'parts_history.json'),
    hr: path.join(DATA_DIR, 'hr.json'),
    roles: path.join(DATA_DIR, 'roles.json'),
    sales: path.join(DATA_DIR, 'sales.json'),
    inventory: path.join(DATA_DIR, 'inventory.json'),
    customers: path.join(DATA_DIR, 'customers.json'),
    suppliers: path.join(DATA_DIR, 'suppliers.json'),
    tasks: path.join(DATA_DIR, 'tasks.json'),
    products: path.join(DATA_DIR, 'products.json'),
    shipping: path.join(DATA_DIR, 'shipping.json'),
    finance_records: path.join(DATA_DIR, 'finance_records.json'),
    fin_categories: path.join(DATA_DIR, 'fin_categories.json'),
    timekeeping: path.join(DATA_DIR, 'timekeeping.json'),
    payroll_settings: path.join(DATA_DIR, 'payroll_settings.json'),
    payroll_records: path.join(DATA_DIR, 'payroll_records.json'),
    payroll_templates: path.join(DATA_DIR, 'payroll_templates.json'),
    ink_prices: path.join(DATA_DIR, 'ink_prices.json'),
    scrapers: path.join(DATA_DIR, 'scrapers.json'),
    monthly_utilities: path.join(DATA_DIR, 'monthly_utilities.json')
};

// Phục vụ trực tiếp giao diện Frontend tại thư mục chứa code
app.use(express.static(__dirname));
// Cho phép Frontend truy cập vào 2 thư mục này qua link /avatars/... và /audio/...
app.use('/avatars', express.static(AVATARS_DIR));
app.use('/audio', express.static(AUDIO_DIR));

// Khai báo danh sách đầy đủ các đường dẫn tĩnh tiếng Việt sẽ map về index.html (Bao gồm /he-thong và /tram-kcs)
const frontendRoutes = [
    '/', '/thong-ke', '/thu-chi', '/cong-no', '/bao-cao', '/giao-viec', '/ban-hang', '/tram-kcs',
    '/thanh-pham', '/kho-vat-tu', '/van-chuyen', '/nha-cung-cap', '/khach-hang', 
    '/nhan-su', '/cham-cong', '/quan-ly-may-in', '/may-in', '/ho-so', 
    '/cai-dat', '/he-thong', '/cai-dat-he-thong', '/lich-su', '/tien-ich'
];

app.get(frontendRoutes, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Dấu mốc thời gian thay đổi dữ liệu giúp đồng bộ mạng LAN nhẹ hơn 95%
let globalDataVersion = Date.now();
app.use((req, res, next) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        globalDataVersion = Date.now();
    }
    next();
});
app.get('/api/sync-version', (req, res) => {
    res.json({ version: globalDataVersion });
});

// ==========================================
// CẤU HÌNH MIDDLEWARE & ROUTER
// ==========================================

// ==========================================
// HỆ THỐNG ĐỌC GHI FILE AN TOÀN (CHỐNG XUNG ĐỘT)
// ==========================================
const fileLocks = {};
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function readJsonFile(filePath, defaultData = []) {
    try {
        if (!fs.existsSync(filePath)) return defaultData;
        const data = await fsP.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.error(`[Lỗi đọc file] ${filePath}:`, err.message);
        // Tự động khôi phục dữ liệu nếu file JSON (đặc biệt là hr.json) bị tràn chuỗi ảnh Base64 quá 5MB
        try {
            const raw = await fsP.readFile(filePath, 'utf8');
            let cleaned = raw.replace(/"avatar"\s*:\s*"data:image\/[^"\r\n]*(?:"|$)/g, '"avatar": ""');
            try {
                const parsed = JSON.parse(cleaned);
                await fsP.writeFile(filePath, JSON.stringify(parsed, null, 2), 'utf8');
                console.log(`-> [Tự động sửa lỗi] Đã khôi phục hoàn chỉnh file ${path.basename(filePath)}!`);
                return parsed;
            } catch (e1) {
                try {
                    const parsedFixed = JSON.parse(cleaned + '\n  }\n]');
                    await fsP.writeFile(filePath, JSON.stringify(parsedFixed, null, 2), 'utf8');
                    console.log(`-> [Tự động sửa lỗi] Đã đóng ngoặc và cứu thành công file ${path.basename(filePath)}!`);
                    return parsedFixed;
                } catch (e2) {
                    const matches = cleaned.match(/\{[^{}]*\}/g);
                    if (matches && matches.length > 0) {
                        const recovered = matches.map(m => { try { return JSON.parse(m); } catch (e) { return null; } }).filter(Boolean);
                        if (recovered.length > 0) {
                            await fsP.writeFile(filePath, JSON.stringify(recovered, null, 2), 'utf8');
                            console.log(`-> [Tự động sửa lỗi] Đã cứu được ${recovered.length} bản ghi trong ${path.basename(filePath)}!`);
                            return recovered;
                        }
                    }
                }
            }
        } catch (recoverErr) {}
        return defaultData;
    }
}

async function writeJsonFile(filePath, data) {
    // Chờ nếu file đang được tiến trình khác ghi (Tránh lỗi parse JSON)
    while (fileLocks[filePath]) {
        await delay(50);
    }
    fileLocks[filePath] = true;
    try {
        await fsP.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (err) {
        console.error(`[Lỗi ghi file] ${filePath}:`, err.message);
        return false;
    } finally {
        fileLocks[filePath] = false;
    }
}

function initSystem() {
    if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
    if (!fs.existsSync(AVATARS_DIR)) fs.mkdirSync(AVATARS_DIR); // Tạo thư mục avatars
    if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);     // Tạo thư mục audio
    const defaults = {
        ink_history: [], parts_history: [], inventory: [], products: [], customers: [], suppliers: [], sales: [], shipping: [],
        finance_records: [], timekeeping: [], payroll_settings: [], payroll_records: [], ink_prices: [],
        fin_categories: { 
            thu: ['Shopee', 'Lazada', 'Khach1Local', 'Khách Lẻ', 'Tặng, Biếu'], 
            chi: ['Ăn uống', 'Đầu tư thiết bị', 'Linh kiện máy in', 'Mua Mực', 'Mua Giấy', 'Mua Decal', 'Tiền Điện/Nước', 'Trả Lương'] 
        },
        roles: [
            { id: 1, name: 'Admin', permissions: ['dashboard','finance','reports','tasks','sales','products','inventory','shipping','customers','suppliers','debts','hr','payroll','history','printer_mgr','settings'], defaultPage: 'dashboard' },
            { id: 2, name: 'Nhân viên', permissions: ['dashboard','tasks','sales','customers','history','printer_mgr','settings'], defaultPage: 'tasks' }
        ],
        hr: [
            { id: 1, name: 'Xuân Nhi', dob: '1990-01-01', address: 'An Giang', phone: '0900000000', role: 'Admin', username: 'admin', password: '123', avatar: '' }
        ],
        scrapers: [
            { id: 1, name: 'Ricoh C5100', type: 'ricoh', ip: '192.168.1.234', active: true }
        ]
    };

    for (const [key, filePath] of Object.entries(FILES)) {
        if (defaults[key] && !fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaults[key], null, 2));
        } else if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify([], null, 2));
        }
    }
}
initSystem();

let latestCounters = { bwTotal: 0, colorTotal: 0 };
let latestCountersByPrinter = {}; // Lưu Counter riêng từng máy theo IP
let latestJobsByPrinter = {};     // Lưu lịch sử in riêng từng máy theo IP
let globalBrowser = null;
let printerStatus = {}; // Lưu trạng thái online/offline của các máy

// ==========================================
// API ĐIỀU KHIỂN, ĐỒNG BỘ & TRẠNG THÁI BOT
// ==========================================
app.get('/api/printer-status', (req, res) => {
    res.json(printerStatus);
});

app.get('/api/printers-counters', async (req, res) => {
    if (typeof getReliablePrinterCounters === 'function') {
        res.json(await getReliablePrinterCounters());
    } else {
        res.json(latestCountersByPrinter);
    }
});

app.get('/api/sync-all', async (req, res) => {
    try {
        const allData = {};
        for (const [key, filePath] of Object.entries(FILES)) {
            allData[key] = await readJsonFile(filePath);
        }
        res.json(allData);
    } catch (err) { res.status(500).json({}); }
});

app.post('/api/sync-key', async (req, res) => {
    try {
        const { key, data } = req.body;
        if (FILES[key]) await writeJsonFile(FILES[key], data);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/restart-scrapers', async (req, res) => {
    try {
        console.log("-> Nhận lệnh Khởi động lại Bot từ WebApp...");
        if (globalBrowser) {
            await globalBrowser.close().catch(() => console.log("-> Bỏ qua lỗi khi đóng browser cũ"));
            globalBrowser = null;
        }
        // Đặt lại trạng thái chờ
        for(let ip in printerStatus) {
            printerStatus[ip] = { status: 'offline', time: Date.now(), name: printerStatus[ip].name, error: 'Đang khởi động lại...' };
        }
        startSystem();
        res.json({ success: true, message: 'Đã khởi động lại hệ thống Bot.' });
    } catch (err) {
        console.error("Lỗi khi khởi động lại Bot:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ==========================================
// API BÁO CÁO THỐNG KÊ
// ==========================================
app.get('/api/reports-data', async (req, res) => {
    try {
        let reportData = {};
        const initDate = (dateStr) => { if (!reportData[dateStr]) reportData[dateStr] = { pages: 0, ink: 0, parts: 0 }; };

        if (fs.existsSync(HISTORY_DIR)) {
            const files = await fsP.readdir(HISTORY_DIR);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const dateStr = file.replace('.json', '');
                initDate(dateStr);
                const jobs = await readJsonFile(path.join(HISTORY_DIR, file));
                jobs.forEach(job => {
                    if (job.status && job.status.includes('Complete')) { 
                        reportData[dateStr].pages += parseInt(job.pages) || 0; 
                    }
                });
            }
        }
        res.json(reportData);
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// ==========================================
// API ĐĂNG NHẬP VÀ DASHBOARD
// ==========================================
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body; 
        const hr = await readJsonFile(FILES.hr); 
        const user = hr.find(u => u.username === username && u.password === password);
        if (user) res.json({ success: true, user }); 
        else res.status(401).json({ success: false, message: 'Sai tài khoản/mật khẩu!' });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/dashboard', async (req, res) => {
    const dash = await readJsonFile(FILES.dashboard, { hardwareBW:0, hardwareColor:0, totalToday:0, totalWeek:0, totalMonth:0, hourlyData:new Array(24).fill(0) });
    res.json(dash);
});

app.get('/api/dashboard/:date', async (req, res) => {
    try {
        const targetDate = req.params.date;
        let totalToday = 0, totalWeek = 0, totalMonth = 0; 
        let hourlyData = new Array(24).fill(0);
        const currentMonthPrefix = targetDate.substring(0, 7);
        const targetDateObj = new Date(targetDate);
        
        if (fs.existsSync(HISTORY_DIR)) {
            const files = await fsP.readdir(HISTORY_DIR);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const fileDateStr = file.replace('.json', ''); 
                const fileDate = new Date(fileDateStr);
                
                const jobs = await readJsonFile(path.join(HISTORY_DIR, file)); 
                let dayTotal = 0;
                jobs.forEach(job => {
                    const pages = parseInt(job.pages) || 0;
                    if (job.status && job.status.includes('Complete')) {
                        dayTotal += pages;
                        if (fileDateStr === targetDate) {
                            const match = job.time.match(/(\d{1,2}):\d{2}/);
                            if (match) {
                                const h = parseInt(match[1], 10);
                                if (h >= 0 && h < 24) hourlyData[h] += pages;
                            }
                        }
                    }
                });
                if (fileDateStr.startsWith(currentMonthPrefix) && fileDateStr <= targetDate) totalMonth += dayTotal;
                const diffDays = Math.ceil(Math.abs(targetDateObj - fileDate) / (1000 * 60 * 60 * 24));
                if (fileDate <= targetDateObj && diffDays <= 7) totalWeek += dayTotal;
                if (fileDateStr === targetDate) totalToday = dayTotal;
            }
        }
        res.json({ totalToday, totalWeek, totalMonth, hourlyData });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/live-history', async (req, res) => { res.json(await readJsonFile(FILES.data, { jobs: [] })); });
app.get('/api/print-history/:date', async (req, res) => { const filePath = path.join(HISTORY_DIR, `${req.params.date}.json`); res.json(await readJsonFile(filePath, [])); });

app.get('/api/print-history-range', async (req, res) => {
    try {
        const { from, to } = req.query;
        let results = [];
        if (!from || !to) return res.json([]);
        if (fs.existsSync(HISTORY_DIR)) {
            const files = await fsP.readdir(HISTORY_DIR);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const dateStr = file.replace('.json', '');
                if (dateStr >= from && dateStr <= to) {
                    const jobs = await readJsonFile(path.join(HISTORY_DIR, file));
                    results = results.concat(jobs);
                }
            }
        }
        res.json(results);
    } catch (err) {
        res.status(500).json([]);
    }
});

// ==========================================
// HỆ THỐNG AUTO-CRUD CHO CÁC MODULE
// ==========================================
function generateCRUD(endpoint, fileKey) {
    app.get(`/api/${endpoint}`, async (req, res) => res.json(await readJsonFile(FILES[fileKey])));
    app.post(`/api/${endpoint}`, async (req, res) => { 
        try {
            const data = await readJsonFile(FILES[fileKey]); 
            const newItem = { id: Date.now() + Math.random().toString().slice(2, 6), ...req.body };
            if(['tasks', 'sales', 'finance_records', 'payroll_records', 'scrapers', 'suppliers'].includes(endpoint)) {
                data.unshift(newItem);
            } else {
                data.push(newItem);
            }
            await writeJsonFile(FILES[fileKey], data); 
            res.json({ success: true, data: newItem }); 
        } catch(err) { res.status(500).json({ success: false }); }
    });
    app.put(`/api/${endpoint}/:id`, async (req, res) => { 
        try {
            const data = await readJsonFile(FILES[fileKey]); 
            const index = data.findIndex(p => String(p.id) === String(req.params.id)); 
            if (index !== -1) { 
                data[index] = { ...data[index], ...req.body }; 
                await writeJsonFile(FILES[fileKey], data); res.json({ success: true }); 
            } else res.status(404).json({ success: false, message: 'Not found' }); 
        } catch(err) { res.status(500).json({ success: false }); }
    });
    app.delete(`/api/${endpoint}/:id`, async (req, res) => { 
        try {
            let data = await readJsonFile(FILES[fileKey]); 
            data = data.filter(p => String(p.id) !== String(req.params.id)); 
            await writeJsonFile(FILES[fileKey], data); res.json({ success: true }); 
        } catch(err) { res.status(500).json({ success: false }); }
    });
}

generateCRUD('roles', 'roles');
generateCRUD('shipping', 'shipping');
generateCRUD('products', 'products');
generateCRUD('inventory', 'inventory');
generateCRUD('customers', 'customers');
generateCRUD('suppliers', 'suppliers');
generateCRUD('hr', 'hr');
generateCRUD('tasks', 'tasks');
generateCRUD('finance_records', 'finance_records');
generateCRUD('timekeeping', 'timekeeping');
generateCRUD('payroll_settings', 'payroll_settings');
generateCRUD('payroll_records', 'payroll_records');
generateCRUD('ink-history', 'ink_history'); 
generateCRUD('parts-history', 'parts_history'); 
generateCRUD('scrapers', 'scrapers'); 
generateCRUD('ink_prices', 'ink_prices');
generateCRUD('ink-prices', 'ink_prices');
generateCRUD('monthly_utilities', 'monthly_utilities');
generateCRUD('monthly-utilities', 'monthly_utilities');

// API chuyên biệt xử lý Vào Ca / Ra Ca trực tiếp trên Server (Chống ghi đè dữ liệu giữa Điện thoại & Máy tính)
app.post('/api/timekeeping/check-in', async (req, res) => {
    try {
        const { userId, userName, userRole, date, inTime, note } = req.body;
        const tkData = await readJsonFile(FILES.timekeeping, []);
        let idx = tkData.findIndex(tk => (String(tk.userId) === String(userId) || (userName && tk.userName === userName)) && tk.date === date);
        if (idx > -1) {
            tkData[idx].userName = userName || tkData[idx].userName;
            tkData[idx].userRole = userRole || tkData[idx].userRole;
            tkData[idx].sessions.push({ inTime, outTime: null, note: note || '' });
        } else {
            tkData.push({
                id: Date.now().toString(),
                userId,
                userName: userName || '',
                userRole: userRole || 'Nhân viên',
                date,
                sessions: [{ inTime, outTime: null, note: note || '' }]
            });
        }
        await writeJsonFile(FILES.timekeeping, tkData);
        res.json({ success: true, data: tkData });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

app.post('/api/timekeeping/check-out', async (req, res) => {
    try {
        const { userId, userName, date, outTime, note } = req.body;
        const tkData = await readJsonFile(FILES.timekeeping, []);
        let idx = tkData.findIndex(tk => (String(tk.userId) === String(userId) || (userName && tk.userName === userName)) && tk.date === date);
        if (idx > -1 && tkData[idx].sessions && tkData[idx].sessions.length > 0) {
            for (let i = tkData[idx].sessions.length - 1; i >= 0; i--) {
                if (!tkData[idx].sessions[i].outTime) {
                    tkData[idx].sessions[i].outTime = outTime;
                    if (note) {
                        tkData[idx].sessions[i].note = (tkData[idx].sessions[i].note ? tkData[idx].sessions[i].note + ' | ' : '') + note;
                    }
                    break;
                }
            }
            await writeJsonFile(FILES.timekeeping, tkData);
        }
        res.json({ success: true, data: tkData });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}); 

app.post('/api/sales', async (req, res) => { 
    try {
        const sales = await readJsonFile(FILES.sales); 
        sales.unshift({ id: 'DH' + Date.now().toString().slice(-6), timestamp: new Date().toLocaleString('vi-VN'), ...req.body }); 
        await writeJsonFile(FILES.sales, sales); res.json({ success: true }); 
    } catch(err) { res.status(500).json({ success: false }); }
});
app.get('/api/sales', async (req, res) => res.json(await readJsonFile(FILES.sales)));
app.put('/api/sales/:id', async (req, res) => { 
    try {
        const data = await readJsonFile(FILES.sales); 
        const index = data.findIndex(p => String(p.id) === String(req.params.id)); 
        if (index !== -1) { data[index] = { ...data[index], ...req.body }; await writeJsonFile(FILES.sales, data); res.json({ success: true }); } 
        else res.status(404).json({ success: false, message: 'Not found' }); 
    } catch(err) { res.status(500).json({ success: false }); }
});
app.delete('/api/sales/:id', async (req, res) => { 
    try {
        let data = await readJsonFile(FILES.sales); 
        data = data.filter(p => String(p.id) !== String(req.params.id)); 
        await writeJsonFile(FILES.sales, data); res.json({ success: true }); 
    } catch(err) { res.status(500).json({ success: false }); }
});

app.get('/api/fin_categories', async (req, res) => res.json(await readJsonFile(FILES.fin_categories, {thu:[], chi:[]})));
app.post('/api/fin_categories', async (req, res) => { await writeJsonFile(FILES.fin_categories, req.body); res.json({ success: true }); });

app.get('/api/payroll_templates', async (req, res) => { res.json(await readJsonFile(FILES.payroll_templates, { schedules: [], shifts: [] })); });
app.post('/api/payroll_templates', async (req, res) => { await writeJsonFile(FILES.payroll_templates, req.body); res.json({ success: true }); });

// Hàm khôi phục Counter gần nhất của từng máy in từ lịch sử (đảm bảo khi máy in Offline vẫn có đúng Counter từng máy)
async function getReliablePrinterCounters() {
    try {
        const scrapers = await readJsonFile(FILES.scrapers, []);
        const inkHistory = await readJsonFile(FILES.ink_history, []);
        const partsHistory = await readJsonFile(FILES.parts_history, []);
        const result = { ...latestCountersByPrinter };

        scrapers.forEach(s => {
            const ip = s.ip;
            const name = s.name;
            const live = result[ip];
            if (!live || (!live.bwTotal && !live.colorTotal)) {
                // Tìm bản ghi lịch sử gần nhất của đúng máy in này (khớp theo IP hoặc Tên máy)
                const matchedInk = inkHistory.find(r => r.printerId === ip || (r.printerName && r.printerName === name));
                const matchedPart = partsHistory.find(r => r.printerId === ip || (r.printerName && r.printerName === name));
                let bw = 0, color = 0;
                if (matchedInk) {
                    bw = Math.max(bw, parseInt(matchedInk.bwCounter) || 0);
                    color = Math.max(color, parseInt(matchedInk.colorCounter) || 0);
                }
                if (matchedPart) {
                    bw = Math.max(bw, parseInt(matchedPart.bwCounter) || 0);
                    color = Math.max(color, parseInt(matchedPart.colorCounter) || 0);
                }
                result[ip] = {
                    printerId: ip,
                    printerName: name,
                    bwTotal: bw,
                    colorTotal: color
                };
            }
        });
        latestCountersByPrinter = result;
        return result;
    } catch (e) {
        return latestCountersByPrinter;
    }
}

app.get('/api/printers-counters-full', async (req, res) => {
    res.json(await getReliablePrinterCounters());
});

app.post('/api/save-ink', async (req, res) => { 
    try {
        const { printerId, printerName, y, m, c, k, type, bwCounter, colorCounter, user, userId, staffCode } = req.body; 
        await getReliablePrinterCounters();
        const pCounter = (printerId && latestCountersByPrinter[printerId]) ? latestCountersByPrinter[printerId] : { bwTotal: 0, colorTotal: 0 };
        const finalBw = (bwCounter !== undefined && Number(bwCounter) > 0) ? Number(bwCounter) : (pCounter.bwTotal || 0);
        const finalColor = (colorCounter !== undefined && Number(colorCounter) > 0) ? Number(colorCounter) : (pCounter.colorTotal || 0);

        if (printerId && printerId !== 'all') {
            latestCountersByPrinter[printerId] = {
                printerId,
                printerName: printerName || 'Máy 1',
                bwTotal: finalBw,
                colorTotal: finalColor
            };
        }

        const newRecord = { 
            id: Date.now() + Math.random().toString().slice(2, 6),
            timestamp: new Date().toLocaleString('vi-VN'), 
            printerId: printerId || 'default',
            printerName: printerName || 'Máy 1',
            userId: userId || '',
            staffCode: staffCode || '',
            user: user || 'Nhân sự',
            staff: user || 'Nhân sự',
            type, 
            y: parseFloat(y)||0, m: parseFloat(m)||0, c: parseFloat(c)||0, k: parseFloat(k)||0, 
            bwCounter: finalBw, 
            colorCounter: finalColor 
        }; 
        const history = await readJsonFile(FILES.ink_history); 
        history.unshift(newRecord); 
        await writeJsonFile(FILES.ink_history, history); res.json({ success: true, data: newRecord }); 
    } catch(err) { res.status(500).json({ success: false }); }
});

app.post('/api/save-parts', async (req, res) => {
    try {
        const { printerId, printerName, parts, bwCounter, colorCounter, user, userId, staffCode } = req.body;
        await getReliablePrinterCounters();
        const pCounter = (printerId && latestCountersByPrinter[printerId]) ? latestCountersByPrinter[printerId] : { bwTotal: 0, colorTotal: 0 };
        const finalBw = (bwCounter !== undefined && Number(bwCounter) > 0) ? Number(bwCounter) : (pCounter.bwTotal || 0);
        const finalColor = (colorCounter !== undefined && Number(colorCounter) > 0) ? Number(colorCounter) : (pCounter.colorTotal || 0);

        const history = await readJsonFile(FILES.parts_history);
        const timestamp = new Date().toLocaleString('vi-VN');
        parts.forEach(p => {
            history.unshift({
                id: Date.now() + Math.random().toString().slice(2, 6), 
                timestamp,
                printerId: printerId || 'default',
                printerName: printerName || 'Máy 1',
                userId: userId || '',
                staffCode: staffCode || '',
                user: user || 'Nhân sự',
                staff: user || 'Nhân sự',
                colorUnit: p.colorUnit, partName: p.partName,
                colorCounter: finalColor, 
                bwCounter: finalBw
            });
        });
        await writeJsonFile(FILES.parts_history, history); res.json({ success: true });
    } catch(err) { res.status(500).json({ success: false }); }
});

// ==========================================
// API UPLOAD FILE (Không xóa file cũ nhờ Date.now())
// ==========================================
const storageAvatar = multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATARS_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const uploadAvatar = multer({ storage: storageAvatar });

app.post('/api/upload-avatar', uploadAvatar.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'Chưa chọn file' });
    res.json({ success: true, filePath: '/avatars/' + req.file.filename });
});

const storageAudio = multer.diskStorage({
    destination: (req, file, cb) => cb(null, AUDIO_DIR),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const uploadAudio = multer({ storage: storageAudio });

app.post('/api/upload-audio', uploadAudio.single('audio'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: 'Chưa chọn file' });
    res.json({ success: true, filePath: '/audio/' + req.file.filename });
});

// ==========================================
// API ĐỔI MẬT KHẨU CHO ADMIN / NHÂN SỰ
// ==========================================
app.post('/api/change-password', async (req, res) => {
    try {
        const { userId, oldPassword, newPassword } = req.body;
        let hrData = await readJsonFile(FILES.hr);
        let userIndex = hrData.findIndex(u => String(u.id) === String(userId));
        
        if (userIndex === -1) return res.status(404).json({ success: false, message: 'Không tìm thấy nhân sự!' });
        if (hrData[userIndex].password !== oldPassword) return res.status(400).json({ success: false, message: 'Mật khẩu cũ không chính xác!' });
        
        hrData[userIndex].password = newPassword;
        await writeJsonFile(FILES.hr, hrData);
        res.json({ success: true, message: 'Đổi mật khẩu thành công!' });
    } catch(err) {
        res.status(500).json({ success: false, message: 'Lỗi server' });
    }
});

app.listen(3000, () => console.log('--- HỆ THỐNG MÁY CHỦ ERP ĐANG CHẠY TẠI CỔNG 3000 ---'));

// ==========================================
// LUỒNG BOT CÀO DỮ LIỆU TỰ ĐỘNG ĐA THIẾT BỊ
// ==========================================
function getTodayString() { 
    const d = new Date(); 
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; 
}

function formatPrinterTime(timeStr) {
    if (!timeStr) return timeStr;
    try {
        let d = new Date(timeStr);
        if (isNaN(d.getTime())) return timeStr; 
        const days = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
        const dayName = days[d.getDay()];
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = d.getFullYear();
        const hh = String(d.getHours()).padStart(2, '0');
        const min = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        return `${dayName} ${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
    } catch(e) { return timeStr; }
}

function parseVNDate(timeStr) {
    if (!timeStr) return 0;
    try {
        const stdTime = new Date(timeStr).getTime();
        if (!isNaN(stdTime)) return stdTime;
        const parts = timeStr.split(' ');
        if (parts.length >= 3) {
            const dateParts = parts[parts.length - 2].split('/'); 
            const timeParts = parts[parts.length - 1].split(':'); 
            return new Date(dateParts[2], dateParts[1] - 1, dateParts[0], timeParts[0], timeParts[1], timeParts[2]).getTime();
        }
        return 0;
    } catch(e) { return 0; }
}

async function updateDashboardStats(hardwareCounters) {
    try {
        const todayStr = getTodayString(); 
        const currentMonthPrefix = todayStr.substring(0, 7); 
        const now = new Date();
        let totalToday = 0, totalWeek = 0, totalMonth = 0; 
        let hourlyData = new Array(24).fill(0);
        
        if (fs.existsSync(HISTORY_DIR)) {
            const files = await fsP.readdir(HISTORY_DIR);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                const fileDateStr = file.replace('.json', ''); 
                const fileDate = new Date(fileDateStr);
                
                const jobs = await readJsonFile(path.join(HISTORY_DIR, file)); 
                let dayTotal = 0;
                jobs.forEach(job => {
                    const pages = parseInt(job.pages) || 0;
                    if (job.status && job.status.includes('Complete')) { 
                        dayTotal += pages; 
                        if (fileDateStr === todayStr) { 
                            const match = job.time.match(/(\d{1,2}):\d{2}/);
                            if (match) {
                                const h = parseInt(match[1], 10);
                                if (h >= 0 && h < 24) hourlyData[h] += pages;
                            }
                        } 
                    }
                });
                if (fileDateStr.startsWith(currentMonthPrefix)) totalMonth += dayTotal;
                if (Math.ceil(Math.abs(now - fileDate) / (1000 * 60 * 60 * 24)) <= 7) totalWeek += dayTotal;
                if (fileDateStr === todayStr) totalToday = dayTotal;
            }
        }

        const oldDash = await readJsonFile(FILES.dashboard, {});
        const lastBw = oldDash.hardwareBW || 0;
        const lastColor = oldDash.hardwareColor || 0;
        const finalBw = (hardwareCounters && hardwareCounters.bwTotal > 0) ? hardwareCounters.bwTotal : lastBw;
        const finalColor = (hardwareCounters && hardwareCounters.colorTotal > 0) ? hardwareCounters.colorTotal : lastColor;
        latestCounters = { bwTotal: finalBw, colorTotal: finalColor };

        await writeJsonFile(FILES.dashboard, { 
            timestamp: now.toLocaleTimeString(), hardwareBW: finalBw, hardwareColor: finalColor, totalToday, totalWeek, totalMonth, hourlyData 
        });
    } catch(err) {
        console.error("Lỗi khi update Dashboard Stats:", err.message);
    }
}

// ----------------------------------------------------
// LOGIC QUÉT RICOH (ĐÃ NÂNG CẤP XỬ LÝ LỖI & BỘ NHỚ)
// ----------------------------------------------------
async function startRicohScraper(browser, scraperObj) {
    const ip = typeof scraperObj === 'string' ? scraperObj : scraperObj.ip;
    const printerName = (typeof scraperObj === 'object' && scraperObj.name) ? scraperObj.name : `Ricoh (${ip})`;
    console.log(`-> Đang khởi chạy luồng quét ${printerName} (IP: ${ip})...`);
    let pageHistory = null;
    let pageCounter = null;

    const initPages = async () => {
        try {
            // ĐÃ TỐI ƯU: Gán thẳng null sau khi đóng để dọn rác RAM triệt để
            if (pageHistory) { await pageHistory.close().catch(() => {}); pageHistory = null; }
            if (pageCounter) { await pageCounter.close().catch(() => {}); pageCounter = null; }
            
            pageHistory = await browser.newPage();
            pageCounter = await browser.newPage();
            
            await pageHistory.setRequestInterception(true);
            pageHistory.on('request', (req) => {
                if(['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });

            await pageCounter.setRequestInterception(true);
            pageCounter.on('request', (req) => {
                if(['image', 'font', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });
        } catch (e) {
            console.error(`[Init Pages] Không thể tạo page mới cho ${ip}:`, e.message);
        }
    };

    await initPages();

    let loopCount = 0; // ĐÃ THÊM: Biến đếm chu kỳ để xả RAM

    while (true) {
        loopCount++;
        
        // ĐÃ THÊM: Cứ sau 30 lần quét (khoảng 7.5 phút), Hủy Tab cũ và tạo Tab mới để xả sạch 100% RAM
        if (loopCount > 30) {
            console.log(`[Khôi phục RAM] Đóng và tạo lại Tab mới cho máy ${printerName}...`);
            await initPages();
            loopCount = 0;
        }

        try {
            await pageHistory.goto(`http://${ip}/web/guest/en/webprinter/jobHistory.cgi`, { waitUntil: 'domcontentloaded', timeout: 10000 });
            await pageCounter.goto(`http://${ip}/web/guest/en/websys/status/getUnificationCounter.cgi`, { waitUntil: 'domcontentloaded', timeout: 10000 });
            
            const rawJobHistoryData = await pageHistory.evaluate(() => {
                const results = []; 
                document.querySelectorAll('table tr').forEach(row => { 
                    const cols = row.querySelectorAll('td'); 
                    if (cols.length >= 7) { 
                        const id = cols[0].innerText.trim(); 
                        if (id !== 'ID' && id !== '' && id.toLowerCase() !== 'back') {
                            const pagesRaw = cols[6].innerText.trim();
                            const pagesClean = pagesRaw.replace(/,/g, '');
                            results.push({ id, user: cols[1].innerText.trim(), file: cols[3].innerText.trim(), status: cols[4].innerText.trim(), time: cols[5].innerText.trim(), pages: pagesClean }); 
                        }
                    } 
                }); 
                return results;
            });
            
            const jobHistoryData = rawJobHistoryData.map(job => ({ 
                ...job, 
                id: `[${printerName}] #${job.id}`,
                printerId: ip,
                printerName: printerName,
                time: formatPrinterTime(job.time) 
            }));

            latestJobsByPrinter[ip] = jobHistoryData;
            const mergedJobs = Object.values(latestJobsByPrinter).flat().sort((a, b) => parseVNDate(b.time) - parseVNDate(a.time));
            await writeJsonFile(FILES.data, { timestamp: new Date().toLocaleTimeString(), jobs: mergedJobs });
            
            printerStatus[ip] = { status: 'online', time: Date.now(), name: printerName, error: null };
            
            const todayStr = getTodayString(); 
            const historyFilePath = path.join(HISTORY_DIR, `${todayStr}.json`); 
            let dailyHistory = await readJsonFile(historyFilePath, []); 
            let isUpdated = false;
            
            jobHistoryData.forEach(job => { 
                let existingJob = dailyHistory.find(h => h.id === job.id && h.file === job.file);
                if (!existingJob) {
                    dailyHistory.push(job); isUpdated = true; 
                } else if (existingJob.status !== job.status || existingJob.pages !== job.pages || existingJob.time !== job.time) {
                    existingJob.status = job.status; existingJob.pages = job.pages; existingJob.time = job.time; isUpdated = true;
                }
            });
            
            if (isUpdated) { 
                dailyHistory.sort((a, b) => parseVNDate(b.time) - parseVNDate(a.time)); 
                await writeJsonFile(historyFilePath, dailyHistory); 
            }

            const currentHardwareCounters = await pageCounter.evaluate(() => {
                let bwTotal = 0, colorTotal = 0, currentSection = '', seenCopier = false, seenPrinter = false;
                // Cách 1: Quét theo cấu trúc bảng <tr> của Ricoh (Tương thích cả C5100 và C5110s)
                const rows = document.querySelectorAll('table tr');
                rows.forEach(tr => {
                    const text = (tr.innerText || '').trim();
                    if (!text) return;
                    if ((text === 'Copier' || text.startsWith('Copier')) && !text.includes(':') && !seenCopier) { currentSection = 'Copier'; seenCopier = true; return; }
                    if ((text === 'Printer' || text.startsWith('Printer')) && !text.includes(':') && !seenPrinter) { currentSection = 'Printer'; seenPrinter = true; return; }
                    if (['Fax', 'Send/TX Total', 'Scanner Send', 'Coverage', 'Fax Transmission'].some(k => text.startsWith(k))) { currentSection = 'Other'; return; }

                    if (currentSection === 'Copier' || currentSection === 'Printer') {
                        const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim()).filter(Boolean);
                        if (tds.length >= 2) {
                            const label = tds[0];
                            const valStr = tds[tds.length - 1].replace(/\D/g, '');
                            const val = parseInt(valStr, 10) || 0;
                            if (label.includes('Black & White')) bwTotal += val;
                            else if (label.includes('Full Color') || label.includes('Single Color') || label.includes('Two-color')) colorTotal += val;
                        }
                    }
                });

                // Cách 2: Fallback quét theo dòng text nếu bảng trả về 0
                if (bwTotal === 0 && colorTotal === 0) {
                    currentSection = ''; seenCopier = false; seenPrinter = false;
                    const lines = document.body.innerText.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        let line = lines[i].trim();
                        if (!line) continue;
                        if (line === 'Copier' && !seenCopier) { currentSection = 'Copier'; seenCopier = true; }
                        else if (line === 'Printer' && !seenPrinter) { currentSection = 'Printer'; seenPrinter = true; }
                        else if (['Fax', 'Send/TX Total', 'Scanner Send', 'Coverage', 'Fax Transmission'].includes(line) || (line === 'Copier' && seenCopier) || (line === 'Printer' && seenPrinter)) currentSection = 'Other';

                        if (currentSection === 'Copier' || currentSection === 'Printer') {
                            if (line.includes(':')) {
                                let parts = line.split(':');
                                let value = parseInt(parts[1].replace(/\D/g, '')) || 0;
                                if (parts[0].includes('Black & White')) bwTotal += value;
                                else if (parts[0].includes('Full Color') || parts[0].includes('Single Color') || parts[0].includes('Two-color')) colorTotal += value;
                            }
                        }
                    }
                }
                return { colorTotal, bwTotal };
            });

            if (currentHardwareCounters.bwTotal > 0 || currentHardwareCounters.colorTotal > 0) {
                latestCountersByPrinter[ip] = {
                    printerId: ip,
                    printerName: printerName,
                    bwTotal: currentHardwareCounters.bwTotal,
                    colorTotal: currentHardwareCounters.colorTotal
                };
            }

            let sumBW = 0, sumColor = 0;
            Object.values(latestCountersByPrinter).forEach(c => {
                sumBW += (c.bwTotal || 0);
                sumColor += (c.colorTotal || 0);
            });
            
            await updateDashboardStats({ bwTotal: sumBW, colorTotal: sumColor });

            // ĐÃ XÓA MẤY DÒNG GOTO ABOUT:BLANK Ở ĐÂY VÌ ĐÃ CÓ BỘ ĐẾM LOOP XẢ RAM BÊN TRÊN
            
        } catch (err) { 
            console.error(`[Scraper] Lỗi kết nối ${printerName} [${ip}]: ${err.message}. Đang dọn dẹp và khởi tạo lại...`); 
            printerStatus[ip] = { status: 'offline', time: Date.now(), name: printerName, error: err.message };
            await initPages();
            await delay(10000);
            continue;
        }
        
        await delay(15000); 
    }
}

// ----------------------------------------------------
// KHUNG MỞ RỘNG CHO CÁC MÁY CÁN / MÁY IN KHÁC
// ----------------------------------------------------
async function startKonicaScraper(browser, ip) {
    console.log(`-> Đang khởi chạy luồng quét Konica (IP: ${ip})...`);
    let page = null;

    const initPage = async () => {
        try {
            if (page) await page.close().catch(() => {});
            page = await browser.newPage();
            
            // Tối ưu hóa tải trang để tránh quá tải bộ nhớ
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if(['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });
        } catch (e) {
            console.error(`[Init Pages] Không thể tạo page mới cho Konica ${ip}:`, e.message);
        }
    };

    await initPage();

    while(true) { 
        try {
            // ĐƯỜNG DẪN 1: URL Web Monitor của Konica (Thường là /wcd/job.xml hoặc /wcd/system.xml)
            // BẠN CẦN SỬA: Điền chính xác đường dẫn đến trang Lịch sử in của máy Konica
            await page.goto(`http://${ip}/wcd/job.xml`, { waitUntil: 'domcontentloaded', timeout: 10000 });
            
            const konicaJobHistory = await page.evaluate(() => {
                const results = [];
                // ĐƯỜNG DẪN 2: Bóc tách dữ liệu thẻ HTML
                // BẠN CẦN SỬA: Thay '.job-list-row' và các chỉ số 'cols[x]' bằng class thực tế khi F12 Web Monitor Konica
                document.querySelectorAll('.job-list-row').forEach(row => {
                    const cols = row.querySelectorAll('td');
                    if (cols.length >= 6) {
                        results.push({
                            id: 'KN_' + cols[0].innerText.trim(), // Thêm tiền tố KN_ để phân biệt với Ricoh
                            user: cols[1].innerText.trim(),
                            file: cols[2].innerText.trim(),
                            status: cols[3].innerText.trim(),
                            time: cols[4].innerText.trim(),
                            pages: cols[5].innerText.trim().replace(/,/g, '')
                        });
                    }
                });
                return results;
            });

            if (konicaJobHistory.length > 0) {
                // Đổ chung dữ liệu vào FILES.data để render trực tiếp lên "Bảng Lịch Sử Máy In" trên ERP
                const currentData = await readJsonFile(FILES.data, { jobs: [] });
                // Gộp lịch sử in Konica vào mảng chung (cần logic lọc trùng lặp ID nếu cần thiết)
                const combinedJobs = [...konicaJobHistory, ...currentData.jobs].slice(0, 50); // Giữ 50 dòng mới nhất
                await writeJsonFile(FILES.data, { timestamp: new Date().toLocaleTimeString('vi-VN'), jobs: combinedJobs });
            }
            
            if(!printerStatus[ip] || printerStatus[ip].status !== 'online') {
                printerStatus[ip] = { status: 'online', time: Date.now(), name: 'Máy Konica', error: null };
            }

            // Dọn dẹp RAM nội bộ cho Puppeteer sau mỗi chu kỳ
            await page.goto('about:blank');
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCache');
            await client.send('Network.clearBrowserCookies');

        } catch (err) {
            console.error(`[Scraper] Lỗi kết nối Konica [${ip}]: ${err.message}. Đang thử khởi tạo lại...`);
            if(!printerStatus[ip] || printerStatus[ip].status !== 'offline') {
                printerStatus[ip] = { status: 'offline', time: Date.now(), name: 'Máy Konica', error: err.message };
            }
            await initPage();
            await delay(10000); // Rớt mạng thì chờ 10s trước khi quét lại
            continue;
        }
        
        await delay(15000); 
    }
}

async function startHupuScraper(browser, ip) {
    console.log(`-> Đang khởi chạy luồng quét HUPU 560 (IP: ${ip})...`);
    let page = null;

    const initPage = async () => {
        try {
            if (page) await page.close().catch(() => {});
            page = await browser.newPage();
            
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                if(['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
                else req.continue();
            });
        } catch (e) {
            console.error(`[Init Pages] Không thể tạo page mới cho HUPU ${ip}:`, e.message);
        }
    };

    await initPage();

    while(true) { 
        try {
            // URL Màn hình điều khiển máy cán HUPU (thường qua bộ đọc IoT / ESP32 nội bộ)
            await page.goto(`http://${ip}/status`, { waitUntil: 'domcontentloaded', timeout: 10000 });
            
            const hupuData = await page.evaluate(() => {
                // BẠN CẦN SỬA: ID thẻ HTML hiển thị số mét cán thực tế trên Web Hupu
                let totalMetersRaw = document.querySelector('#total_meters') ? document.querySelector('#total_meters').innerText : '0';
                let currentStatus = document.querySelector('#machine_status') ? document.querySelector('#machine_status').innerText : 'Sẵn sàng';
                return { 
                    meters: parseFloat(totalMetersRaw.replace(/[^\d.-]/g, '')), 
                    status: currentStatus 
                };
            });

            // Ghi nhận số liệu mét cán vào chung Dashboard.json để hệ thống có thể thống kê
            const dash = await readJsonFile(FILES.dashboard, {});
            dash.hupuMeters = hupuData.meters;
            dash.hupuStatus = hupuData.status;
            await writeJsonFile(FILES.dashboard, dash);
            
            if(!printerStatus[ip] || printerStatus[ip].status !== 'online') {
                printerStatus[ip] = { status: 'online', time: Date.now(), name: 'Máy Cán HUPU', error: null };
            }

            await page.goto('about:blank');
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCache');

        } catch (err) {
            console.error(`[Scraper] Lỗi kết nối HUPU [${ip}]: ${err.message}. Đang thử khởi tạo lại...`);
            if(!printerStatus[ip] || printerStatus[ip].status !== 'offline') {
                printerStatus[ip] = { status: 'offline', time: Date.now(), name: 'Máy Cán HUPU', error: err.message };
            }
            await initPage();
            await delay(10000);
            continue;
        }

        await delay(15000); 
    }
}

// ==========================================
// TRÌNH QUẢN LÝ TỔNG (KHỞI ĐỘNG HỆ THỐNG)
// ==========================================
async function startSystem() {
    updateDashboardStats({ bwTotal: 0, colorTotal: 0 });
    try {
        // Tối ưu hóa Puppeteer Arguments để chống sập (Memory leak)
        globalBrowser = await puppeteer.launch({ 
            headless: 'new',
            
            // NẾU MUỐN CHẠY BẰNG MICROSOFT EDGE: Xóa 2 dấu gạch chéo // ở đầu dòng dưới đây
            // executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',

            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-zygote', // Tắt tiến trình fork dư thừa
                '--disable-extensions', // Không load tiện ích mở rộng
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--js-flags="--max-old-space-size=256"' // Ép V8 Engine chỉ được dùng tối đa 256MB RAM cho mỗi Tab
            ]
        });
        
        const scrapers = await readJsonFile(FILES.scrapers, []);
        let activeScrapers = scrapers.filter(s => s.active);
        
        if(activeScrapers.length === 0) {
            console.log("-> KHÔNG có luồng quét (Scraper) nào đang được BẬT trong Cài đặt.");
        }

        // Chạy luồng quét dữ liệu tự động cho tất cả các máy in đang bật
        const tasks = activeScrapers.map(s => {
            if(s.type === 'ricoh') return startRicohScraper(globalBrowser, s);
            if(s.type === 'konica') return startKonicaScraper(globalBrowser, s.ip);
        });
        
        Promise.all(tasks).catch(err => console.error("Lỗi tổng trong quá trình quét:", err));

    } catch(err) { console.error("Không thể khởi động trình duyệt Puppeteer:", err); }
}

// Bảo vệ Node.js Server không bị sập hoàn toàn nếu có exception bất ngờ
process.on('uncaughtException', (err) => {
    console.error('Lỗi nghiêm trọng không được bắt (Uncaught Exception):', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('Lỗi Promise bị từ chối (Unhandled Rejection):', reason);
});

startSystem();

// ==========================================
// BỘ DỌN RÁC TỔNG (AUTO-RESTART BROWSER SAU MỖI 6 TIẾNG)
// ==========================================
setInterval(async () => {
    console.log("==========================================");
    console.log("⏰ BẢO TRÌ ĐỊNH KỲ: ĐANG TỰ ĐỘNG KHỞI ĐỘNG LẠI BOT ĐỂ XẢ TOÀN BỘ RAM...");
    console.log("==========================================");
    
    if (globalBrowser) {
        await globalBrowser.close().catch(() => {});
        globalBrowser = null;
    }
    
    // Cập nhật trạng thái hiển thị trên Web UI
    for(let ip in printerStatus) {
        printerStatus[ip] = { status: 'offline', time: Date.now(), name: printerStatus[ip].name, error: 'Bảo trì xả RAM định kỳ...' };
    }
    
    startSystem();
}, 6 * 60 * 60 * 1000); // 6 tiếng