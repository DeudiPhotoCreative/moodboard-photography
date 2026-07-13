const express = require('express');
const { Storage, File } = require('megajs');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const DB_FILE = path.join(__dirname, 'data.json');
let megaStorage = null;
let isAdminAuthenticated = false;

// Database Helper (Dilengkapi Auto-Migrasi ke Kategori Global & Pengaturan Link MEGA)
const readDB = () => {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ albums: [], categories: [], photos: [], settings: { megaFolderUrl: "" } }, null, 2));
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.settings) data.settings = { megaFolderUrl: "" };

    // AUTO-MIGRASI: Menggabungkan kategori duplikat lama menjadi 1 Kategori Global yang bersih
    const uniqueCats = [];
    const catMap = {}; // memetakan id lama ke id global baru
    data.categories.forEach(c => {
        const nameLower = c.name.trim().toLowerCase();
        const existing = uniqueCats.find(u => u.name.trim().toLowerCase() === nameLower);
        if (existing) {
            catMap[c.id] = existing.id;
        } else {
            uniqueCats.push({ id: c.id, name: c.name.trim() });
            catMap[c.id] = c.id;
        }
    });
    // Perbarui referensi foto ke ID kategori global yang sudah dirapikan
    data.photos.forEach(p => {
        if (catMap[p.categoryId]) p.categoryId = catMap[p.categoryId];
    });
    data.categories = uniqueCats;

    return data;
};
const writeDB = (data) => fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));

// Helper: Cari atau Buat Folder secara aman di MEGA
async function getFolder(parent, name) {
    try {
        if (!parent.children) {
            try { await parent.loadAttributes(); } catch (e) { }
        }
        let folder = parent.children && parent.children.find(f => f.directory && f.name === name);
        if (!folder) {
            folder = await parent.mkdir(name);
            if (parent.children && folder) parent.children.push(folder);
        }
        return folder || parent;
    } catch (e) {
        console.log("Info MEGA Folder: Menggunakan folder induk sebagai alternatif.", e.message);
        return parent;
    }
}

// Helper: Mencari folder kustom milik Admin di dalam akun MEGA
async function findFolderInStorage(parent, urlOrName) {
    if (!parent || !parent.children || !urlOrName) return null;
    for (const child of parent.children) {
        if (child.directory) {
            if (child.name === urlOrName || urlOrName.includes(child.name)) return child;
            if (child.nodeId && urlOrName.includes(child.nodeId)) return child;
            const found = await findFolderInStorage(child, urlOrName);
            if (found) return found;
        }
    }
    return null;
}

// ================= AUTHENTICATION & SETTINGS =================
app.post('/api/login', async (req, res) => {
    const { role, email, password } = req.body;
    if (role === 'admin') {
        try {
            megaStorage = await new Storage({ email, password }).ready;
            isAdminAuthenticated = true;
            return res.json({ success: true, role: 'admin' });
        } catch (error) {
            isAdminAuthenticated = false;
            return res.status(401).json({ success: false, message: 'Gagal login MEGA. Periksa email/password.' });
        }
    }
    return res.json({ success: true, role: 'user' });
});

app.post('/api/logout', (req, res) => {
    megaStorage = null;
    isAdminAuthenticated = false;
    res.json({ success: true });
});

const adminOnly = (req, res, next) => {
    if (!isAdminAuthenticated || !megaStorage) return res.status(403).json({ message: 'Sesi Admin habis, silakan login ulang.' });
    next();
};

app.post('/api/settings', adminOnly, (req, res) => {
    const db = readDB();
    db.settings.megaFolderUrl = req.body.megaFolderUrl || "";
    writeDB(db);
    res.json({ success: true, settings: db.settings });
});

// ================= API CRUD (READ, CREATE, UPDATE) =================
app.get('/api/data', (req, res) => res.json(readDB()));

app.post('/api/albums', adminOnly, (req, res) => {
    const db = readDB();
    const newAlbum = { id: 'alb_' + Date.now(), name: req.body.name };
    db.albums.push(newAlbum); writeDB(db); res.json(newAlbum);
});
app.put('/api/albums/:id', adminOnly, (req, res) => {
    const db = readDB(); const item = db.albums.find(a => a.id === req.params.id);
    if (item) { item.name = req.body.name; writeDB(db); } res.json({ success: true });
});

// KATEGORI GLOBAL: Dibuat tanpa mengikat pada album tertentu
app.post('/api/categories', adminOnly, (req, res) => {
    const db = readDB();
    const nameLower = req.body.name.trim().toLowerCase();
    const existing = db.categories.find(c => c.name.toLowerCase() === nameLower);
    if (existing) return res.json(existing); // Jika sudah ada, langsung kembalikan kategori global tersebut

    const newCat = { id: 'cat_' + Date.now(), name: req.body.name.trim() };
    db.categories.push(newCat); writeDB(db); res.json(newCat);
});
app.put('/api/categories/:id', adminOnly, (req, res) => {
    const db = readDB(); const item = db.categories.find(c => c.id === req.params.id);
    if (item) { item.name = req.body.name.trim(); writeDB(db); } res.json({ success: true });
});

// UPDATE FOTO: Bisa mengubah Caption DAN Memindahkan Kategori!
app.put('/api/photos/:id', adminOnly, (req, res) => {
    const db = readDB(); const item = db.photos.find(p => p.id === req.params.id);
    if (item) {
        if (req.body.caption !== undefined) item.caption = req.body.caption;
        if (req.body.categoryId) item.categoryId = req.body.categoryId; // Memindahkan kategori
        writeDB(db);
    } res.json({ success: true });
});

// ================= UPLOAD FOTO (RENAME: ALBUM - KATEGORI - NOMOR) =================
app.post('/api/photos', adminOnly, upload.array('photos', 50), async (req, res) => {
    try {
        const { albumId, categoryId, caption } = req.body;
        if (!req.files || req.files.length === 0) return res.status(400).send('Kosong');

        const db = readDB();
        const targetAlbum = db.albums.find(a => a.id === albumId);
        const targetCategory = db.categories.find(c => c.id === categoryId);
        if (!targetAlbum || !targetCategory) return res.status(404).send('Data tidak valid');

        let baseMegaFolder = megaStorage.root;
        if (db.settings.megaFolderUrl) {
            try {
                if (!megaStorage.root.children) await megaStorage.root.loadAttributes();
                const foundCustom = await findFolderInStorage(megaStorage.root, db.settings.megaFolderUrl);
                if (foundCustom) baseMegaFolder = foundCustom;
            } catch (e) { console.log("Folder custom tidak ditemukan, menggunakan root folder."); }
        }

        const appFolder = await getFolder(baseMegaFolder, 'MoodboardApps');
        const targetMegaFolder = await getFolder(appFolder, targetAlbum.name);

        const uploadedPhotos = [];
        let counter = db.photos.filter(p => p.albumId === albumId && p.categoryId === categoryId).length + 1;

        for (const file of req.files) {
            const ext = path.extname(file.originalname) || '.jpg';
            const newFileName = `${targetAlbum.name} - ${targetCategory.name} - ${counter}${ext}`;

            let megaLink = "";
            try {
                const megaFile = await targetMegaFolder.upload({ name: newFileName, size: file.buffer.length }, file.buffer).complete;
                megaLink = await megaFile.link();
            } catch (uploadErr) {
                console.log("Upload ke subfolder mengalami kendala, mengalihkan ke root folder...", uploadErr.message);
                const fallbackFile = await megaStorage.root.upload({ name: newFileName, size: file.buffer.length }, file.buffer).complete;
                megaLink = await fallbackFile.link();
            }

            const newPhoto = {
                id: 'img_' + Date.now() + Math.floor(Math.random() * 1000),
                albumId, categoryId, caption: caption || '',
                megaLink: megaLink,
                megaFileName: newFileName
            };
            db.photos.push(newPhoto);
            uploadedPhotos.push(newPhoto);
            counter++;
        }

        writeDB(db);
        res.json({ success: true, photos: uploadedPhotos });
    } catch (error) {
        console.error("Critical Upload Error:", error);
        res.status(500).json({ error: error.message || 'Terjadi kesalahan internal pada server' });
    }
});

// ================= API DELETE (KEBAL ERROR MEGA) =================
app.delete('/api/photos/:id', adminOnly, async (req, res) => {
    const db = readDB();
    const photo = db.photos.find(p => p.id === req.params.id);

    if (photo && photo.megaFileName) {
        try {
            const alb = db.albums.find(a => a.id === photo.albumId);
            const appF = await getFolder(megaStorage.root, 'MoodboardApps');
            const albF = await getFolder(appF, alb ? alb.name : '');
            if (albF && albF.children) {
                const targetFile = albF.children.find(f => f.name === photo.megaFileName);
                if (targetFile) await targetFile.delete();
            }
        } catch (e) { console.log("Hapus fisik MEGA diabaikan/gagal, tetap menghapus dari aplikasi."); }
    }

    db.photos = db.photos.filter(p => p.id !== req.params.id);
    writeDB(db); res.json({ success: true });
});

app.delete('/api/categories/:id', adminOnly, (req, res) => {
    const db = readDB();
    db.categories = db.categories.filter(c => c.id !== req.params.id);
    db.photos = db.photos.filter(p => p.categoryId !== req.params.id); // Cascade
    writeDB(db); res.json({ success: true });
});

app.delete('/api/albums/:id', adminOnly, (req, res) => {
    const db = readDB();
    db.albums = db.albums.filter(a => a.id !== req.params.id);
    db.categories = db.categories.filter(c => c.albumId !== req.params.id);
    db.photos = db.photos.filter(p => p.albumId !== req.params.id); // Cascade
    writeDB(db); res.json({ success: true });
});

// ================= PROXY CACHE LOAD CEPAT =================
app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL dibutuhkan');
    try {
        const file = File.fromURL(url);
        await file.loadAttributes();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=2592000'); // Cache 30 Hari
        file.download().pipe(res);
    } catch (e) { res.status(500).send('Gagal'); }
});

app.listen(3000, () => console.log('Server berjalan di port 3000'));