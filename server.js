require('dotenv').config();
const express = require('express');
const { Storage, File } = require('megajs');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ================= OPTIMASI KONEKSI MONGODB (SERVERLESS) =================
let isConnected = false;

async function connectDB() {
    if (isConnected) return;
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI belum diatur di Environment Variables!");
    }
    try {
        const db = await mongoose.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 5000
        });
        isConnected = db.connections[0].readyState === 1;
        console.log('✅ Berhasil terhubung ke MongoDB Atlas!');
    } catch (err) {
        console.error('❌ Gagal terhubung ke MongoDB:', err.message);
        throw err;
    }
}

// Middleware proteksi database & ANTI-CACHE VERCEL
app.use('/api', async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    try {
        await connectDB();
        next();
    } catch (e) {
        res.status(500).json({ success: false, message: "Database Error" });
    }
});

// ================= SCHEMA & MODELS =================
const AlbumSchema = new mongoose.Schema({
    _id: String,
    name: String
}, { versionKey: false });

const CategorySchema = new mongoose.Schema({
    _id: String,
    albumId: String,
    name: String
}, { versionKey: false });

const PhotoSchema = new mongoose.Schema({
    _id: String,
    albumId: String,
    categoryId: String,
    caption: String,
    megaLink: String,
    megaFileName: String
}, { versionKey: false });

const SettingSchema = new mongoose.Schema({
    _id: String,
    megaFolderUrl: String
}, { versionKey: false });

const Album = mongoose.models.Album || mongoose.model('Album', AlbumSchema, 'albums');
const Category = mongoose.models.Category || mongoose.model('Category', CategorySchema, 'categories');
const Photo = mongoose.models.Photo || mongoose.model('Photo', PhotoSchema, 'photos');
const Setting = mongoose.models.Setting || mongoose.model('Setting', SettingSchema, 'settings');

// ================= MANAJEMEN SESI MEGA (ANTI METU / LOGOUT) =================
let megaStorage = null;

async function getMegaStorage() {
    // 1. Jika sesi sudah ada dan aktif di memori, pakai yang ada
    if (megaStorage && megaStorage.status === 'ready') return megaStorage;

    // 2. Jika sesi kosong (karena serverless Vercel restart), login otomatis dari .env
    if (process.env.MEGA_EMAIL && process.env.MEGA_PASSWORD) {
        console.log("🔄 Menghubungkan ulang sesi MEGA secara otomatis...");
        try {
            megaStorage = await new Storage({
                email: process.env.MEGA_EMAIL,
                password: process.env.MEGA_PASSWORD,
                keepalive: true
            }).ready;
            return megaStorage;
        } catch (e) {
            console.error("❌ Auto-Login MEGA Gagal:", e.message);
            throw new Error("Gagal otentikasi otomatis ke MEGA.");
        }
    }
    throw new Error("Sesi MEGA berakhir atau kredensial .env belum diatur.");
}

// Helper mencari folder di MEGA
async function findFolderInStorage(parentFolder, folderNameOrUrl) {
    if (!parentFolder.children) return null;
    for (const child of parentFolder.children) {
        if (child.name === folderNameOrUrl || child.downloadUrl === folderNameOrUrl) {
            return child;
        }
        if (child.directory) {
            const found = await findFolderInStorage(child, folderNameOrUrl);
            if (found) return found;
        }
    }
    return null;
}

async function getFolder(parentFolder, name) {
    if (!parentFolder.children) await parentFolder.loadAttributes();
    let folder = parentFolder.children.find(f => f.name === name && f.directory);
    if (!folder) {
        folder = await parentFolder.mkdir(name);
    }
    return folder;
}

// Middleware validasi Admin berbasis Sesi Otomatis
const adminOnly = async (req, res, next) => {
    try {
        await getMegaStorage();
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: error.message });
    }
};

// ================= ROUTING API =================

// Login manual tetap disediakan sebagai fitur pelengkap
app.post('/api/login', async (req, res) => {
    const { role, email, password } = req.body;
    if (role === 'admin') {
        try {
            megaStorage = await new Storage({ email, password, keepalive: true }).ready;
            return res.json({ success: true, role: 'admin' });
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Login MEGA Gagal.' });
        }
    }
    res.json({ success: true, role: 'user' });
});

// Ambil Semua Data
app.get('/api/data', async (req, res) => {
    try {
        const [albums, categories, photos] = await Promise.all([
            Album.find().lean(),
            Category.find().lean(),
            Photo.find().lean()
        ]);
        res.json({
            albums: albums.map(d => ({ ...d, id: d._id })),
            categories: categories.map(d => ({ ...d, id: d._id })),
            photos: photos.map(d => ({ ...d, id: d._id }))
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Tambah Album
app.post('/api/albums', adminOnly, async (req, res) => {
    try {
        const { name } = req.body;
        const newAlbum = new Album({ _id: 'alb_' + Date.now(), name });
        await newAlbum.save();
        res.json({ success: true, album: { ...newAlbum.toObject(), id: newAlbum._id } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Tambah Kategori
app.post('/api/categories', adminOnly, async (req, res) => {
    try {
        const { albumId, name } = req.body;
        const newCat = new Category({ _id: 'cat_' + Date.now(), albumId, name });
        await newCat.save();
        res.json({ success: true, category: { ...newCat.toObject(), id: newCat._id } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// Upload Foto Tunggal (Diproses Cepat untuk Menghindari Batasan Vercel)
app.post('/api/photos', adminOnly, upload.array('photo', 1), async (req, res) => {
    try {
        const { albumId, categoryId, caption } = req.body;
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, message: 'Pilih file foto.' });
        }

        const targetAlbum = await Album.findById(albumId);
        const targetCategory = await Category.findById(categoryId);
        if (!targetAlbum || !targetCategory) {
            return res.status(404).json({ success: false, message: 'Album atau Kategori tidak valid.' });
        }

        const settings = await Setting.findById('global_settings');
        let baseMegaFolder = megaStorage.root;

        if (settings && settings.megaFolderUrl) {
            try {
                if (!megaStorage.root.children) await megaStorage.root.loadAttributes();
                const foundCustom = await findFolderInStorage(megaStorage.root, settings.megaFolderUrl);
                if (foundCustom) baseMegaFolder = foundCustom;
            } catch (e) { }
        }

        const appFolder = await getFolder(baseMegaFolder, 'MoodboardApps');
        const targetMegaFolder = await getFolder(appFolder, targetAlbum.name);

        const file = req.files[0];
        const ext = path.extname(file.originalname) || '.jpg';
        const existingPhotosCount = await Photo.countDocuments({ albumId, categoryId });
        const newFileName = `${targetAlbum.name} - ${targetCategory.name} - ${existingPhotosCount + 1}${ext}`;

        let megaLink = "";
        try {
            const megaFile = await targetMegaFolder.upload({ name: newFileName, size: file.buffer.length }, file.buffer).complete;
            megaLink = await megaFile.link();
        } catch (err) {
            const fallbackFile = await megaStorage.root.upload({ name: newFileName, size: file.buffer.length }, file.buffer).complete;
            megaLink = await fallbackFile.link();
        }

        const newPhoto = new Photo({
            _id: 'img_' + Date.now() + Math.floor(Math.random() * 1000),
            albumId, categoryId, caption: caption || '',
            megaLink, megaFileName: newFileName
        });

        await newPhoto.save();
        res.json({ success: true, photo: { ...newPhoto.toObject(), id: newPhoto._id } });
    } catch (error) {
        res.status(500).json({ success: false, message: "Gagal upload ke MEGA: " + error.message });
    }
});

// Hapus Kategori
app.delete('/api/categories/:id', adminOnly, async (req, res) => {
    try {
        await Category.findByIdAndDelete(req.params.id);
        await Photo.deleteMany({ categoryId: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal menghapus kategori: " + err.message });
    }
});

// Hapus Album
app.delete('/api/albums/:id', adminOnly, async (req, res) => {
    try {
        await Album.findByIdAndDelete(req.params.id);
        await Photo.deleteMany({ albumId: req.params.id });
        await Category.deleteMany({ albumId: req.params.id });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Gagal menghapus album: " + err.message });
    }
});

// Image Proxy (Supaya Gambar bypass batas CORS)
app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL dibutuhkan');
    try {
        const file = File.fromURL(url);
        await file.loadAttributes();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=2592000'); // Cache 30 Hari
        file.download().pipe(res);
    } catch (e) {
        res.status(500).send('Gagal memuat gambar');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server berjalan di port ${PORT}`));

module.exports = app;
