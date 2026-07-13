require('dotenv').config();
const express = require('express');
const { Storage, File } = require('megajs');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const mongoose = require('mongoose'); // Import Mongoose

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ================= KONEKSI MONGODB =================
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Berhasil terhubung ke MongoDB Atlas!'))
    .catch(err => console.error('❌ Gagal terhubung ke MongoDB:', err));

// ================= DEFINISI STRUKTUR DATABASE (SCHEMA) =================
const Album = mongoose.model('Album', new mongoose.Schema({
    _id: String, name: String
}, { versionKey: false }));

const Category = mongoose.model('Category', new mongoose.Schema({
    _id: String, name: String
}, { versionKey: false }));

const Photo = mongoose.model('Photo', new mongoose.Schema({
    _id: String, albumId: String, categoryId: String, caption: String,
    megaLink: String, megaFileName: String
}, { versionKey: false }));

const Setting = mongoose.model('Setting', new mongoose.Schema({
    _id: String, megaFolderUrl: String
}, { versionKey: false }));

let megaStorage = null;
let isAdminAuthenticated = false;

// Helper: Format data dari MongoDB agar atribut '_id' berubah menjadi 'id' untuk menyesuaikan frontend
const formatData = (arr) => arr.map(doc => ({ ...doc, id: doc._id }));

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

app.post('/api/settings', adminOnly, async (req, res) => {
    await Setting.findByIdAndUpdate(
        'global_settings',
        { megaFolderUrl: req.body.megaFolderUrl || "" },
        { upsert: true }
    );
    const settings = await Setting.findById('global_settings').lean();
    res.json({ success: true, settings: settings });
});

// ================= API CRUD MONGODB (READ, CREATE, UPDATE) =================
app.get('/api/data', async (req, res) => {
    const albums = await Album.find().lean();
    const categories = await Category.find().lean();
    const photos = await Photo.find().lean();
    const settings = await Setting.findById('global_settings').lean() || { megaFolderUrl: "" };

    res.json({
        albums: formatData(albums),
        categories: formatData(categories),
        photos: formatData(photos),
        settings: settings
    });
});

app.post('/api/albums', adminOnly, async (req, res) => {
    const newAlbum = new Album({ _id: 'alb_' + Date.now(), name: req.body.name });
    await newAlbum.save();
    res.json({ id: newAlbum._id, name: newAlbum.name });
});

app.put('/api/albums/:id', adminOnly, async (req, res) => {
    await Album.findByIdAndUpdate(req.params.id, { name: req.body.name });
    res.json({ success: true });
});

// KATEGORI GLOBAL: Dibuat tanpa mengikat pada album tertentu
app.post('/api/categories', adminOnly, async (req, res) => {
    const nameLower = req.body.name.trim().toLowerCase();
    // Cek duplikasi kategori global menggunakan regex (case-insensitive)
    const existing = await Category.findOne({ name: { $regex: new RegExp(`^${nameLower}$`, 'i') } });
    if (existing) return res.json({ id: existing._id, name: existing.name });

    const newCat = new Category({ _id: 'cat_' + Date.now(), name: req.body.name.trim() });
    await newCat.save();
    res.json({ id: newCat._id, name: newCat.name });
});

app.put('/api/categories/:id', adminOnly, async (req, res) => {
    await Category.findByIdAndUpdate(req.params.id, { name: req.body.name.trim() });
    res.json({ success: true });
});

// UPDATE FOTO: Bisa mengubah Caption DAN Memindahkan Kategori
app.put('/api/photos/:id', adminOnly, async (req, res) => {
    let updateData = {};
    if (req.body.caption !== undefined) updateData.caption = req.body.caption;
    if (req.body.categoryId) updateData.categoryId = req.body.categoryId;
    await Photo.findByIdAndUpdate(req.params.id, updateData);
    res.json({ success: true });
});

// ================= UPLOAD FOTO (RENAME: ALBUM - KATEGORI - NOMOR) =================
app.post('/api/photos', adminOnly, upload.array('photos', 50), async (req, res) => {
    try {
        const { albumId, categoryId, caption } = req.body;
        if (!req.files || req.files.length === 0) return res.status(400).send('Kosong');

        const targetAlbum = await Album.findById(albumId);
        const targetCategory = await Category.findById(categoryId);
        if (!targetAlbum || !targetCategory) return res.status(404).send('Data tidak valid');

        const settings = await Setting.findById('global_settings');
        let baseMegaFolder = megaStorage.root;

        if (settings && settings.megaFolderUrl) {
            try {
                if (!megaStorage.root.children) await megaStorage.root.loadAttributes();
                const foundCustom = await findFolderInStorage(megaStorage.root, settings.megaFolderUrl);
                if (foundCustom) baseMegaFolder = foundCustom;
            } catch (e) { console.log("Folder custom tidak ditemukan, menggunakan root folder."); }
        }

        const appFolder = await getFolder(baseMegaFolder, 'MoodboardApps');
        const targetMegaFolder = await getFolder(appFolder, targetAlbum.name);

        const uploadedPhotos = [];
        // Hitung jumlah foto yang sudah ada di album & kategori ini untuk penomoran otomatis
        const existingPhotosCount = await Photo.countDocuments({ albumId, categoryId });
        let counter = existingPhotosCount + 1;

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

            const newPhoto = new Photo({
                _id: 'img_' + Date.now() + Math.floor(Math.random() * 1000),
                albumId, categoryId, caption: caption || '',
                megaLink: megaLink,
                megaFileName: newFileName
            });

            await newPhoto.save();
            // Format ulang kembalian agar 'id' dikenali frontend
            uploadedPhotos.push({ ...newPhoto.toObject(), id: newPhoto._id });
            counter++;
        }

        res.json({ success: true, photos: uploadedPhotos });
    } catch (error) {
        console.error("Critical Upload Error:", error);
        res.status(500).json({ error: error.message || 'Terjadi kesalahan internal pada server' });
    }
});

// ================= API DELETE (KEBAL ERROR MEGA) =================
app.delete('/api/photos/:id', adminOnly, async (req, res) => {
    const photo = await Photo.findById(req.params.id);

    if (photo && photo.megaFileName) {
        try {
            const alb = await Album.findById(photo.albumId);
            const appF = await getFolder(megaStorage.root, 'MoodboardApps');
            const albF = await getFolder(appF, alb ? alb.name : '');
            if (albF && albF.children) {
                const targetFile = albF.children.find(f => f.name === photo.megaFileName);
                if (targetFile) await targetFile.delete();
            }
        } catch (e) { console.log("Hapus fisik MEGA diabaikan/gagal, tetap menghapus dari aplikasi database."); }
    }

    await Photo.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

app.delete('/api/categories/:id', adminOnly, async (req, res) => {
    await Category.findByIdAndDelete(req.params.id);
    await Photo.deleteMany({ categoryId: req.params.id }); // Hapus semua foto berantai (Cascade)
    res.json({ success: true });
});

app.delete('/api/albums/:id', adminOnly, async (req, res) => {
    await Album.findByIdAndDelete(req.params.id);
    await Photo.deleteMany({ albumId: req.params.id }); // Hapus semua foto berantai (Cascade)
    res.json({ success: true });
});

// ================= PROXY CACHE LOAD CEPAT =================
app.get('/api/proxy-image', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL dibutuhkan');
    try {
        const file = File.fromURL(url);
        await file.loadAttributes();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=2592000'); // Cache 30 Hari di memori HP
        file.download().pipe(res);
    } catch (e) { res.status(500).send('Gagal'); }
});

// ================= KONFIGURASI VERCEL =================
if (process.env.NODE_ENV !== 'production') {
    app.listen(3000, () => console.log('Server berjalan di port 3000'));
}
module.exports = app;